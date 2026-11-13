// =========================================================================
// PAPALÉGUAS - MÓDULO MODULAR DE ROTAS: CURATOR & RECOMENDAÇÕES
// =========================================================================
// Responsável pelas rotas de curadoria inteligente de conteúdo,
// detecção de país, preferências (curtidas / descurtidas por dispositivo)
// e tendências (trending / recent) para o BaixaTube e Home.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { swallowed } = require('../logger');

const COUNTRY_NAMES = {
  BR: 'Brasil', US: 'Estados Unidos', GB: 'Reino Unido', AR: 'Argentina',
  MX: 'México', PT: 'Portugal', ES: 'Espanha', FR: 'França', DE: 'Alemanha',
  IT: 'Itália', JP: 'Japão', KR: 'Coreia do Sul', CN: 'China', RU: 'Rússia',
  CA: 'Canadá', AU: 'Austrália', IN: 'Índia', NG: 'Nigéria', ZA: 'África do Sul',
  TR: 'Turquia', PL: 'Polônia', NL: 'Países Baixos', SE: 'Suécia', NO: 'Noruega'
};

const COUNTRY_FLAGS = {
  BR: '🇧🇷', US: '🇺🇸', GB: '🇬🇧', AR: '🇦🇷', MX: '🇲🇽', PT: '🇵🇹',
  ES: '🇪🇸', FR: '🇫🇷', DE: '🇩🇪', IT: '🇮🇹', JP: '🇯🇵', KR: '🇰🇷',
  CN: '🇨🇳', RU: '🇷🇺', CA: '🇨🇦', AU: '🇦🇺', IN: '🇮🇳', NG: '🇳🇬',
  ZA: '🇿🇦', TR: '🇹🇷', PL: '🇵🇱', NL: '🇳🇱', SE: '🇸🇪', NO: '🇳🇴'
};

// =========================================================================
// PERSISTÊNCIA DE PREFERÊNCIAS DE VÍDEO POR DISPOSITIVO (CURTIR / DESCURTIR)
// =========================================================================
const PREFS_SAFE_DIR = path.join(os.homedir(), '.config', 'papaleguas_prefs');
const PREFS_SAFE_FILE = path.join(PREFS_SAFE_DIR, 'device_video_prefs.json');
const PREFS_DIR = path.join(os.homedir(), '.papaleguas_downloads');
const PREFS_FILE = path.join(PREFS_DIR, 'device_video_prefs.json');
const PREFS_BACKUP_DIR = path.join(__dirname, '../../data');
const PREFS_BACKUP_FILE = path.join(PREFS_BACKUP_DIR, 'device_video_prefs.json');

const TOPIC_STOPWORDS = new Set([
  'para', 'como', 'mais', 'menos', 'muito', 'tudo', 'todos', 'todas', 'sobre',
  'esse', 'essa', 'este', 'esta', 'isso', 'aquilo', 'entre', 'depois', 'antes',
  'hoje', 'ontem', 'agora', 'novo', 'nova', 'novos', 'novas', 'video', 'videos',
  'oficial', 'official', 'canal', 'live', 'vivo', 'completo', 'completa', 'parte',
  'melhor', 'melhores', 'top', 'brasil', 'mundo', '2024', '2025', '2026', 'clipe',
  'audio', 'hd', '4k', 'full', 'with', 'from', 'that', 'this', 'what', 'when',
  'where', 'quais', 'qual', 'quem', 'porque', 'sera', 'voce', 'voces', 'pelo',
  'pela', 'pelos', 'pelas', 'numa', 'numas', 'nuns', 'dele', 'dela', 'deles',
  'acaba', 'acabou', 'explodir', 'explodiu', 'entrou', 'entra', 'fase', 'tiram',
  'tirou', 'muda', 'mudou', 'ameaca', 'vida', 'coisa', 'coisas', 'forma', 'jeito',
  'vezes', 'hora', 'horas', 'dias', 'semana', 'meses', 'anos', 'veja', 'olha',
  'urgente', 'bomba', 'chocante', 'incrivel', 'nunca', 'sempre', 'fazer', 'feito',
  'disse', 'falou', 'pode', 'podem', 'estao', 'fomos', 'foram', 'toda', 'todo',
  'cada', 'outro', 'outra', 'mesmo', 'mesma', 'grande', 'grandes', 'pequeno',
  'primeiro', 'primeira', 'ultimo', 'ultima', 'bilhoes', 'trilhoes', 'milhoes',
  'reais', 'dolar', 'dolares', 'portugues', 'news'
]);

const IMPORTANT_SHORT_TOKENS = new Set([
  'ia', 'ai', 'ti', 'tv', 'f1', 'pc', 'vr', '5g', '6g', 'agi', 'gpt', 'llm',
  'php', 'sql', 'css', 'api', 'cpu', 'gpu', 'ram', 'ssd', 'ufc', 'nba', 'nfl',
  'ps5', 'gta', 'stf', 'cpi', 'pib', 'onu', 'eua', 'sus', 'pix', 'btc', 'eth'
]);

function normalizeTokenText(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractVideoTopicKeywords(title, channel = '') {
  const normTitle = normalizeTokenText(title);
  const normChannel = normalizeTokenText(channel);
  const words = normTitle
    .split(' ')
    .filter((w) => (IMPORTANT_SHORT_TOKENS.has(w) || w.length >= 4) && !TOPIC_STOPWORDS.has(w) && !/^\d+$/.test(w));
  const unique = [];
  for (const w of words) {
    if (!unique.includes(w)) unique.push(w);
    if (unique.length >= 6) break;
  }
  if (normChannel && normChannel.length >= 3 && normChannel !== 'baixatube') {
    const chWords = normChannel.split(' ').filter((w) => (IMPORTANT_SHORT_TOKENS.has(w) || w.length >= 4) && !TOPIC_STOPWORDS.has(w));
    for (const cw of chWords) {
      if (!unique.includes(cw) && unique.length < 8) unique.push(cw);
    }
  }
  return unique;
}

let devicePrefsStore = {
  devices: {},
  aliases: {}
};

function mergeProfilesInto(target, source) {
  if (!target || !source) return false;
  if (!Array.isArray(target.likes)) target.likes = [];
  if (!Array.isArray(target.dislikes)) target.dislikes = [];
  let changed = false;

  const dislikedSet = new Set(target.dislikes.map((d) => d && d.id).filter(Boolean));
  const likedSet = new Set(target.likes.map((l) => l && l.id).filter(Boolean));

  if (Array.isArray(source.likes)) {
    for (const lk of source.likes) {
      if (!lk || !lk.id) continue;
      if (!likedSet.has(lk.id) && !dislikedSet.has(lk.id)) {
        target.likes.push(lk);
        likedSet.add(lk.id);
        changed = true;
      }
    }
  }
  if (Array.isArray(source.dislikes)) {
    for (const dk of source.dislikes) {
      if (!dk || !dk.id) continue;
      if (!dislikedSet.has(dk.id) && !likedSet.has(dk.id)) {
        target.dislikes.push(dk);
        dislikedSet.add(dk.id);
        changed = true;
      }
    }
  }
  if (changed) {
    target.likes.sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
    target.dislikes.sort((a, b) => (b.dislikedAt || 0) - (a.dislikedAt || 0));
    if (target.likes.length > 120) target.likes = target.likes.slice(0, 120);
    if (target.dislikes.length > 200) target.dislikes = target.dislikes.slice(0, 200);
    target.updatedAt = Math.max(target.updatedAt || 0, source.updatedAt || Date.now());
  }
  return changed;
}

function loadDevicePrefsStore() {
  const filesToRead = [PREFS_SAFE_FILE, PREFS_BACKUP_FILE, PREFS_FILE];
  for (const file of filesToRead) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.devices && typeof parsed.devices === 'object') {
        for (const [k, prof] of Object.entries(parsed.devices)) {
          if (!prof || typeof prof !== 'object') continue;
          // Ignora dispositivos globais legados para manter o isolamento absoluto por aparelho
          if (k === 'dev_global_sync' || k === 'device_local_pc' || k.startsWith('ip_')) continue;
          if (!devicePrefsStore.devices[k]) {
            devicePrefsStore.devices[k] = {
              likes: Array.isArray(prof.likes) ? prof.likes : [],
              dislikes: Array.isArray(prof.dislikes) ? prof.dislikes : [],
              updatedAt: prof.updatedAt || Date.now()
            };
          } else {
            mergeProfilesInto(devicePrefsStore.devices[k], prof);
          }
        }
      }
      if (parsed.aliases && typeof parsed.aliases === 'object') {
        for (const [aliasK, aliasV] of Object.entries(parsed.aliases)) {
          if (aliasK === 'dev_global_sync' || aliasV === 'dev_global_sync' || aliasK.startsWith('ip_') || aliasK === 'device_local_pc') continue;
          devicePrefsStore.aliases[aliasK] = aliasV;
        }
      }
    } catch (e) { swallowed(e, 'curator:loadDevicePrefsStore@166'); }
  }
  // Exclui completamente resquícios globais
  delete devicePrefsStore.global;
  delete devicePrefsStore.devices['dev_global_sync'];
  delete devicePrefsStore.devices['device_local_pc'];

  // Atualiza as palavras-chave salvas com o extrator limpo (mantendo IA/GPT/AGI e removendo verbos genéricos)
  const refreshListKws = (list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item && item.title) {
        item.keywords = extractVideoTopicKeywords(item.title, item.channel);
      }
    }
  };
  for (const prof of Object.values(devicePrefsStore.devices)) {
    if (prof) {
      refreshListKws(prof.likes);
      refreshListKws(prof.dislikes);
    }
  }
}

function writeAtomicJson(dirPath, filePath, dataStr) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const tmpFile = `${filePath}.${process.pid}.tmp`;
    const fd = fs.openSync(tmpFile, 'w');
    try {
      fs.writeFileSync(fd, dataStr, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpFile, filePath);
  } catch (e) { swallowed(e, 'curator:writeAtomicJson@202'); }
}

function saveDevicePrefsStore() {
  try {
    delete devicePrefsStore.global;
    delete devicePrefsStore.devices['dev_global_sync'];
    delete devicePrefsStore.devices['device_local_pc'];
    const serialized = JSON.stringify(devicePrefsStore, null, 2);
    writeAtomicJson(PREFS_SAFE_DIR, PREFS_SAFE_FILE, serialized);
    writeAtomicJson(PREFS_BACKUP_DIR, PREFS_BACKUP_FILE, serialized);
    writeAtomicJson(PREFS_DIR, PREFS_FILE, serialized);
  } catch (e) { swallowed(e, 'curator:saveDevicePrefsStore@214'); }
}

loadDevicePrefsStore();
saveDevicePrefsStore();

function resolveDeviceSignature(req, reqUrl, body, ctx) {
  let explicitDeviceId = String(
    (body && body.deviceId) ||
    (reqUrl && reqUrl.searchParams.get('deviceId')) ||
    (req && req.headers && (req.headers['x-device-id'] || req.headers['x-client-id'])) ||
    ''
  ).trim().replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 96);

  if ((!explicitDeviceId || explicitDeviceId === 'client_default' || explicitDeviceId === 'dev_global_sync') && req && req.headers && req.headers.cookie) {
    const m = String(req.headers.cookie).match(/(?:^|;\s*)papaleguas_device_id=([^;]+)/);
    if (m && m[1]) {
      try {
        const parsed = decodeURIComponent(m[1]).trim().replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 96);
        if (parsed && parsed !== 'client_default' && parsed !== 'dev_global_sync') {
          explicitDeviceId = parsed;
        }
      } catch (e) { swallowed(e, 'curator:resolveDeviceSignature@236'); }
    }
  }

  if (explicitDeviceId === 'dev_global_sync' || explicitDeviceId === 'client_default') {
    explicitDeviceId = '';
  }

  const devKey = explicitDeviceId
    ? (explicitDeviceId.startsWith('dev_') ? explicitDeviceId : `dev_${explicitDeviceId}`)
    : '';

  // Se o aparelho envia seu identificador de dispositivo, ele é único e exclusivo deste aparelho
  if (devKey) {
    return { primaryKey: devKey, candidateKeys: [devKey] };
  }

  const deviceFp = String(
    (body && body.deviceFp) ||
    (reqUrl && reqUrl.searchParams.get('deviceFp')) ||
    (req && req.headers && req.headers['x-device-fp']) ||
    ''
  ).trim().replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 80);

  if (deviceFp) {
    const hwKey = `dev_fp_${deviceFp.replace(/^fp_/, '')}`;
    return { primaryKey: hwKey, candidateKeys: [hwKey] };
  }

  const clientIpParam = (reqUrl && reqUrl.searchParams.get('deviceIp')) || (body && body.deviceIp) || (req && req.headers && (req.headers['x-device-ip'] || req.headers['x-client-ip'])) || '';
  const rawIp = (ctx && typeof ctx.extractRequestDeviceIp === 'function')
    ? ctx.extractRequestDeviceIp(req, clientIpParam)
    : String(clientIpParam || (req && req.socket && req.socket.remoteAddress) || 'local').replace(/^::ffff:/, '');
  const cleanIp = String(rawIp || 'local').replace(/^::ffff:/, '').trim();

  const ua = String((req && req.headers && req.headers['user-agent']) || 'browser')
    .replace(/\s+/g, ' ')
    .slice(0, 120);

  const ipUaKey = 'ipua_' + Buffer.from(`${cleanIp}__${ua}`).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 48);
  return { primaryKey: ipUaKey, candidateKeys: [ipUaKey] };
}

function getDeviceProfile(req, reqUrl, body, ctx) {
  const { primaryKey, candidateKeys } = resolveDeviceSignature(req, reqUrl, body, ctx);
  let profile = devicePrefsStore.devices[primaryKey];
  if (!profile) {
    profile = { likes: [], dislikes: [], updatedAt: Date.now() };
    devicePrefsStore.devices[primaryKey] = profile;
  }
  if (!Array.isArray(profile.likes)) profile.likes = [];
  if (!Array.isArray(profile.dislikes)) profile.dislikes = [];

  // Cada dispositivo é 100% individual e estritamente isolado:
  // NÃO herda, NÃO sincroniza e NÃO mescla curtidas de outros aparelhos ou perfil global!
  return { key: primaryKey, candidateKeys, profile };
}

function filterAndRankVideosForDevice(videos, profile) {
  if (!Array.isArray(videos) || videos.length === 0) return [];
  if (!profile) return videos;
  const likes = Array.isArray(profile.likes) ? profile.likes : [];
  const dislikes = Array.isArray(profile.dislikes) ? profile.dislikes : [];
  if (likes.length === 0 && dislikes.length === 0) return videos;

  const likedIds = new Set(likes.map((v) => String(v.id || '').trim()).filter(Boolean));
  const dislikedIds = new Set(dislikes.map((v) => String(v.id || '').trim()).filter(Boolean));

  const dislikedChannels = new Set(
    dislikes
      .map((v) => normalizeTokenText(v.channel))
      .filter((c) => c && c.length >= 3 && c !== 'baixatube')
  );

  // Tópicos de vídeos descurtidos (cada item descurtido guarda suas palavras-chave)
  const dislikedPatterns = dislikes.map((v) => {
    const kws = Array.isArray(v.keywords) && v.keywords.length > 0
      ? v.keywords
      : extractVideoTopicKeywords(v.title, v.channel);
    return kws;
  }).filter((kws) => kws.length > 0);

  const likedChannels = new Set(
    likes
      .map((v) => normalizeTokenText(v.channel))
      .filter((c) => c && c.length >= 3 && c !== 'baixatube')
  );
  const likedKeywordsWeight = new Map();
  likes.forEach((v, idx) => {
    const recencyWeight = Math.max(1, 10 - Math.floor(idx / 3));
    const kws = Array.isArray(v.keywords) && v.keywords.length > 0
      ? v.keywords
      : extractVideoTopicKeywords(v.title, v.channel);
    kws.forEach((kw) => {
      likedKeywordsWeight.set(kw, (likedKeywordsWeight.get(kw) || 0) + recencyWeight);
    });
  });

  const filtered = [];
  for (const v of videos) {
    if (!v || !v.id) continue;
    const vid = String(v.id).trim();
    if (dislikedIds.has(vid)) continue;

    const normChannel = normalizeTokenText(v.channel);
    const normTitle = normalizeTokenText(v.title);
    const combinedText = `${normTitle} ${normChannel}`;

    // Se o canal foi descurtido (e não está explicitamente nos canais curtidos), evita mostrar
    if (normChannel && dislikedChannels.has(normChannel) && !likedChannels.has(normChannel) && !likedIds.has(vid)) {
      continue;
    }

    // Verifica se o vídeo bate com o assunto de algum vídeo descurtido
    let matchesDislikedTopic = false;
    if (!likedIds.has(vid)) {
      for (const pattern of dislikedPatterns) {
        const minHits = pattern.length >= 2 ? 2 : 1;
        let hits = 0;
        for (const kw of pattern) {
          if (kw.length >= 4 && combinedText.includes(kw)) {
            hits++;
            if (hits >= minHits) break;
          }
        }
        if (hits >= minHits) {
          matchesDislikedTopic = true;
          break;
        }
      }
    }
    if (matchesDislikedTopic) continue;

    // Calcula afinidade com curtidas do dispositivo
    let likeScore = 0;
    if (likedIds.has(vid)) likeScore += 50;
    if (normChannel && likedChannels.has(normChannel)) likeScore += 25;
    for (const [kw, weight] of likedKeywordsWeight.entries()) {
      if (kw.length >= 4 && combinedText.includes(kw)) {
        likeScore += weight * 3;
      }
    }

    filtered.push({
      ...v,
      liked: likedIds.has(vid),
      relatedToLiked: likeScore >= 12,
      _likeScore: likeScore
    });
  }

  return filtered;
}

const likedRecsCache = new Map();
const likedRecsInFlight = new Map();

async function fetchDeviceLikedRecommendations(profile, countryCode, clientIp, ctx, maxItems = 16, page = 1, forceRefresh = false, clientExcludeIds = []) {
  const effectiveLikes = (profile && Array.isArray(profile.likes) && profile.likes.length > 0)
    ? profile.likes
    : [];

  if (!effectiveLikes || effectiveLikes.length === 0) {
    return [];
  }

  const cCode = countryCode || 'BR';
  // Rotaciona a semente de acordo com a página/tempo para sempre trazer recomendações variadas e novas
  const pageIdx = Math.max(1, parseInt(page || '1', 10));
  // Ao clicar em 'Novos Vídeos' (forceRefresh), gera assinatura única para sempre disparar busca nova no YouTube
  const cacheSig = `${cCode}_p${pageIdx}_${effectiveLikes.slice(0, 5).map((x) => x && x.id).join(',')}${forceRefresh ? `_f${Date.now()}` : ''}`;
  const cached = !forceRefresh ? likedRecsCache.get(cacheSig) : null;

  const runRefresh = async () => {
    if (likedRecsInFlight.has(cacheSig) && !forceRefresh) {
      return likedRecsInFlight.get(cacheSig);
    }
    const promise = (async () => {
      try {
        const hl = ctx.getHlForCountry(cCode);
        const seeds = [];
        const usedChannels = new Set();
        // Alterna dinamicamente as sementes em blocos de acordo com a página/novidades (ex: página 1 pega curtidas 0, 1, 2; página 2 pega 2, 3, 4...)
        const totalLikes = effectiveLikes.length;
        const startOffset = (pageIdx - 1) % totalLikes;
        for (let i = 0; i < totalLikes; i++) {
          const lk = effectiveLikes[(startOffset + i) % totalLikes];
          if (!lk || !lk.id) continue;
          const chKey = normalizeTokenText(lk.channel);
          if (seeds.length < 4 && (!chKey || !usedChannels.has(chKey) || totalLikes <= 4)) {
            if (chKey) usedChannels.add(chKey);
            seeds.push(lk);
          }
          if (seeds.length >= 4) break;
        }
        if (seeds.length === 0 && effectiveLikes[0]) seeds.push(effectiveLikes[0]);

        const excludeIds = [
          ...effectiveLikes.map((x) => x.id),
          ...((profile && profile.dislikes) || []).map((x) => x.id),
          ...(Array.isArray(clientExcludeIds) ? clientExcludeIds : [])
        ].filter(Boolean);

        const tasks = seeds.map(async (seed) => {
          try {
            const kwArr = extractVideoTopicKeywords(seed.title, '');
            const cleanCh = (seed.channel && seed.channel !== 'BaixaTube' && seed.channel !== 'Papaléguas BaixaTube')
              ? String(seed.channel).trim()
              : '';
            const normSeedChannel = normalizeTokenText(cleanCh);
            const topicPart = kwArr.slice(0, 3).join(' ');
            const themePart = (seed.category && seed.category !== 'curtidos' && seed.category !== 'noticias') ? seed.category : '';

            // Prioridade 1: Canal exato da curtida + assunto do vídeo curtido
            // Adiciona rotação variada por página / novidade ('2026', 'novos', 'hoje', 'ultimas horas') para trazer sempre vídeos diferentes e novos
            const timeSuffixList = ['', ' novos', ' hoje', ' 2026', ' ultimas horas', ' lancamentos'];
            const timeSuffix = timeSuffixList[(pageIdx - 1) % timeSuffixList.length];
            const channelAndTopicQuery = cleanCh
              ? `${cleanCh} ${topicPart}${timeSuffix}`.trim()
              : `${themePart} ${topicPart}${timeSuffix}`.trim() || 'noticias';
            // Prioridade 2: Vídeos diretamente do mesmo canal (ou tema + assunto)
            const directChannelQuery = cleanCh || `${themePart} ${topicPart}`.trim() || 'noticias';

            const [channelTopicVideos, directChannelVideos, nativeRelatedVideos] = await Promise.all([
              ctx.searchYoutubeVideos(channelAndTopicQuery, hl, false, '', false, '', cCode, clientIp || '').catch(() => []),
              cleanCh
                ? ctx.searchYoutubeVideos(directChannelQuery, hl, false, '', false, '', cCode, clientIp || '').catch(() => [])
                : Promise.resolve([]),
              typeof ctx.fetchRelatedYoutubeVideos === 'function' && seed.id
                ? ctx.fetchRelatedYoutubeVideos(seed.id, false, hl, cCode).catch(() => [])
                : Promise.resolve([])
            ]);

            const combinedRaw = (pageIdx % 2 === 0)
              ? [
                  ...(Array.isArray(channelTopicVideos) ? channelTopicVideos : []),
                  ...(Array.isArray(nativeRelatedVideos) ? nativeRelatedVideos : []),
                  ...(Array.isArray(directChannelVideos) ? directChannelVideos : [])
                ]
              : [
                  ...(Array.isArray(directChannelVideos) ? directChannelVideos : []),
                  ...(Array.isArray(channelTopicVideos) ? channelTopicVideos : []),
                  ...(Array.isArray(nativeRelatedVideos) ? nativeRelatedVideos : [])
                ];

            // Filtra estritamente para manter apenas vídeos do MESMO CANAL ou do MESMO TEMA/ASSUNTO da curtida
            const strictlyRelated = combinedRaw.filter((v) => {
              if (!v || !v.id || v.id === seed.id) return false;
              const vCh = normalizeTokenText(v.channel);
              const vTitle = normalizeTokenText(v.title);
              const vText = `${vTitle} ${vCh}`;
              const isSameChannel = normSeedChannel && vCh && (vCh === normSeedChannel || vCh.includes(normSeedChannel) || normSeedChannel.includes(vCh));
              if (isSameChannel) return true;
              // Se for de outro canal, precisa coincidir com o assunto central do vídeo curtido
              let matchedKws = 0;
              for (const kw of kwArr) {
                if (kw && vText.includes(kw)) matchedKws++;
              }
              return matchedKws >= (kwArr.length >= 2 ? 2 : 1);
            });

            // Ordena dando prioridade máxima aos vídeos do mesmo canal + tema da curtida
            strictlyRelated.sort((a, b) => {
              const aCh = normalizeTokenText(a.channel);
              const bCh = normalizeTokenText(b.channel);
              const aSame = normSeedChannel && aCh && (aCh === normSeedChannel || aCh.includes(normSeedChannel) || normSeedChannel.includes(aCh)) ? 1 : 0;
              const bSame = normSeedChannel && bCh && (bCh === normSeedChannel || bCh.includes(normSeedChannel) || normSeedChannel.includes(bCh)) ? 1 : 0;
              return bSame - aSame;
            });

            return strictlyRelated.map((v) => ({
              ...v,
              relatedToLiked: true,
              basedOnLikedTitle: seed.title || seed.channel || 'sua curtida'
            }));
          } catch (e) {
            return [];
          }
        });

        const lists = await Promise.all(tasks);
        const merged = [];
        const seen = new Set(excludeIds.map((id) => String(id).toLowerCase()));
        const maxLen = Math.max(0, ...lists.map((l) => l.length));
        for (let i = 0; i < maxLen; i++) {
          for (const list of lists) {
            const item = list[i];
            if (!item || !item.id) continue;
            const idLow = String(item.id).toLowerCase();
            if (seen.has(idLow)) continue;
            seen.add(idLow);
            merged.push(item);
            if (merged.length >= maxItems * 2) break;
          }
          if (merged.length >= maxItems * 2) break;
        }

        if (merged.length > 0) {
          const entry = { ts: Date.now(), items: merged };
          likedRecsCache.set(cacheSig, entry);
        }
        return merged;
      } finally {
        likedRecsInFlight.delete(cacheSig);
      }
    })();

    likedRecsInFlight.set(cacheSig, promise);
    return promise;
  };

  // Stale-while-revalidate: retorna em 0ms do cache e atualiza em background se tiver > 2 min
  if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
    if (Date.now() - cached.ts > 2 * 60 * 1000) {
      runRefresh().catch(() => {});
    }
    return filterAndRankVideosForDevice(cached.items, profile).slice(0, maxItems);
  }

  const fresh = await runRefresh();
  return filterAndRankVideosForDevice(fresh, profile).slice(0, maxItems);
}

let _cachesPurgedOnModuleLoad = false;

/**
 * Manipulador principal do módulo de Curadoria.
 * Retorna true se a requisição foi tratada, ou false caso pertença a outro módulo.
 */
async function handle(req, res, ctx) {
  const { reqUrl, pathname, body = {} } = ctx;
  if (!_cachesPurgedOnModuleLoad) {
    _cachesPurgedOnModuleLoad = true;
    try {
      if (global.__plRecentFeedFastCache) global.__plRecentFeedFastCache.clear();
      if (ctx && typeof ctx.clearYoutubeCaches === 'function') ctx.clearYoutubeCaches();
    } catch (e) { swallowed(e, 'curator:handle@572'); }
  }

  // -----------------------------------------------------------------------
  // 0. PREFERÊNCIAS E JOINHA (CURTIR / DESCURTIR) POR DISPOSITIVO
  // -----------------------------------------------------------------------
  if (pathname === '/api/video-preferences') {
    const { key, profile } = getDeviceProfile(req, reqUrl, body, ctx);
    // Permite sincronizar curtidas/descurtidas salvas localmente no navegador do dispositivo
    if (req.method === 'POST' && body) {
      let changed = false;
      if (Array.isArray(body.likes)) {
        for (const lk of body.likes.slice(0, 60)) {
          if (!lk || !lk.id) continue;
          if (!profile.likes.some((x) => x.id === lk.id) && !profile.dislikes.some((x) => x.id === lk.id)) {
            profile.likes.push({
              id: String(lk.id).trim(),
              title: String(lk.title || '').trim(),
              channel: String(lk.channel || '').trim(),
              thumbnail: String(lk.thumbnail || '').trim(),
              duration: String(lk.duration || '').trim(),
              views: String(lk.views || '').trim(),
              publishedAt: String(lk.publishedAt || '').trim(),
              category: String(lk.category || '').trim(),
              keywords: Array.isArray(lk.keywords) && lk.keywords.length
                ? lk.keywords
                : extractVideoTopicKeywords(lk.title, lk.channel),
              likedAt: lk.likedAt || Date.now()
            });
            changed = true;
          }
        }
      }
      if (Array.isArray(body.dislikes)) {
        for (const dk of body.dislikes.slice(0, 100)) {
          if (!dk || !dk.id) continue;
          if (!profile.dislikes.some((x) => x.id === dk.id)) {
            profile.dislikes.push({
              id: String(dk.id).trim(),
              title: String(dk.title || '').trim(),
              channel: String(dk.channel || '').trim(),
              keywords: Array.isArray(dk.keywords) && dk.keywords.length
                ? dk.keywords
                : extractVideoTopicKeywords(dk.title, dk.channel),
              dislikedAt: dk.dislikedAt || Date.now()
            });
            changed = true;
          }
        }
      }
      if (changed) {
        profile.updatedAt = Date.now();
        saveDevicePrefsStore();
      }
    }
    // Pré-aquece em background as recomendações das curtidas assim que o dispositivo sincroniza preferências
    if (profile.likes && profile.likes.length > 0) {
      fetchDeviceLikedRecommendations(profile, 'BR', '', ctx, 20).catch(() => {});
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      success: true,
      deviceKey: key,
      likes: profile.likes.slice(0, 100),
      dislikes: profile.dislikes.slice(0, 150)
    }));
    return true;
  }

  if (pathname === '/api/video-feedback' && req.method === 'POST') {
    const { key, candidateKeys, profile } = getDeviceProfile(req, reqUrl, body, ctx);
    const action = String(body.action || '').toLowerCase().trim();
    const video = body.video || {};
    const videoId = String(video.id || body.videoId || '').trim();
    if (!videoId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'ID do vídeo ausente' }));
      return true;
    }

    const title = String(video.title || body.title || '').trim();
    const channel = String(video.channel || body.channel || '').trim();
    const keywords = extractVideoTopicKeywords(title, channel);

    // Remove estado anterior desse vídeo apenas no perfil individual deste dispositivo
    const removeVideoFromProfile = (prof) => {
      if (!prof) return;
      if (Array.isArray(prof.likes)) prof.likes = prof.likes.filter((x) => x && x.id !== videoId);
      if (Array.isArray(prof.dislikes)) prof.dislikes = prof.dislikes.filter((x) => x && x.id !== videoId);
    };
    removeVideoFromProfile(profile);

    let relatedVideos = [];
    if (action === 'like') {
      const likeEntry = {
        id: videoId,
        title,
        channel,
        thumbnail: String(video.thumbnail || `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`).trim(),
        duration: String(video.duration || '').trim(),
        views: String(video.views || '').trim(),
        publishedAt: String(video.publishedAt || '').trim(),
        description: String(video.description || '').trim(),
        category: String(body.category || '').trim(),
        keywords,
        likedAt: Date.now()
      };
      profile.likes.unshift(likeEntry);
      if (profile.likes.length > 100) profile.likes = profile.likes.slice(0, 100);
      profile.updatedAt = Date.now();
      saveDevicePrefsStore();

      // Busca imediatamente vídeos relacionados ao vídeo curtido e já abastece o cache de Curtidos deste dispositivo
      try {
        const clientIpParam = (body && body.deviceIp) || req.headers['x-device-ip'] || '';
        const clientIp = ctx.extractRequestDeviceIp(req, clientIpParam);
        const isManualCountry = (body && (body.isManualCountry === true || body.manualCountry === true)) || false;
        const countryCode = (isManualCountry && body.country && /^[A-Z]{2}$/i.test(body.country) && body.country.toUpperCase() !== 'AUTO')
          ? body.country.toUpperCase()
          : await ctx.getClientCountryCode(req, clientIp, false).catch(() => 'BR');
        const excludeList = Array.isArray(body.excludeIds) ? body.excludeIds : [];
        const curatorRes = await ctx.getAiCuratorSuggestions({
          type: 'youtube',
          currentQuery: body.category || keywords.slice(0, 3).join(' ') || 'noticias',
          currentTitle: title,
          currentChannel: channel,
          currentVideoId: videoId,
          excludeTitles: [...excludeList, videoId, ...profile.dislikes.map((d) => d.id)],
          page: 1,
          stayOnTheme: true,
          useAi: false,
          useTor: false,
          country: countryCode,
          clientIp,
          timeFilter: ''
        });
        if (curatorRes && Array.isArray(curatorRes.items)) {
          relatedVideos = filterAndRankVideosForDevice(curatorRes.items, profile)
            .slice(0, 8)
            .map((v) => ({
              ...v,
              relatedToLiked: true,
              basedOnLikedTitle: title || channel
            }));
          if (relatedVideos.length > 0) {
            const cacheSig = `${countryCode}_${profile.likes.slice(0, 3).map((x) => x && x.id).join(',')}`;
            const entry = { ts: Date.now(), items: relatedVideos.slice(0, 40) };
            likedRecsCache.set(cacheSig, entry);
          }
        }
        fetchDeviceLikedRecommendations(profile, countryCode, clientIp, ctx, 20).catch(() => {});
      } catch (e) { swallowed(e, 'curator:handle@723'); }
    } else if (action === 'dislike') {
      const dislikeEntry = {
        id: videoId,
        title,
        channel,
        keywords,
        dislikedAt: Date.now()
      };
      profile.dislikes.unshift(dislikeEntry);
      if (profile.dislikes.length > 200) profile.dislikes = profile.dislikes.slice(0, 200);
      profile.updatedAt = Date.now();
      saveDevicePrefsStore();
    } else {
      profile.updatedAt = Date.now();
      saveDevicePrefsStore();
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      success: true,
      deviceKey: key,
      action,
      videoId,
      keywords,
      channel,
      likesCount: profile.likes.length,
      dislikesCount: profile.dislikes.length,
      relatedVideos
    }));
    return true;
  }

  if (pathname === '/api/youtube-liked-feed') {
    const { key, profile } = getDeviceProfile(req, reqUrl, body, ctx);
    const clientIpParam = reqUrl.searchParams.get('deviceIp') || (body && body.deviceIp) || req.headers['x-device-ip'] || '';
    const clientIp = ctx.extractRequestDeviceIp(req, clientIpParam);
    const clientCountryParam = reqUrl.searchParams.get('country') || (body && body.country) || '';
    const isManualCountry = reqUrl.searchParams.get('manual') === '1' || (body && (body.isManualCountry === true || body.manualCountry === true));

    // O país deve ser rigorosamente determinado pelo IP da conexão atual do visitante
    const detectedCountryFromIp = await ctx.getClientCountryCode(req, clientIp, false).catch(() => 'BR');

    const countryCode = (isManualCountry && clientCountryParam && /^[A-Z]{2}$/i.test(clientCountryParam) && clientCountryParam.toUpperCase() !== 'AUTO')
      ? clientCountryParam.toUpperCase()
      : detectedCountryFromIp;

    const pageParam = parseInt(reqUrl.searchParams.get('page') || (body && body.page) || '1', 10);
    const forceRefresh = reqUrl.searchParams.get('refresh') === '1' || (body && body.refresh === true);
    const excludeIdsRaw = reqUrl.searchParams.get('excludeIds') || (body && body.excludeIds) || '';
    const clientExcludeIds = (typeof excludeIdsRaw === 'string' ? excludeIdsRaw.split(',') : (Array.isArray(excludeIdsRaw) ? excludeIdsRaw : []))
      .map((x) => String(x).trim()).filter(Boolean);

    // Se este aparelho não tem curtidas, retorna vazio imediatamente
    if (!profile || !Array.isArray(profile.likes) || profile.likes.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        success: true,
        deviceKey: key,
        likedCount: 0,
        likes: [],
        videos: []
      }));
      return true;
    }

    const relatedVideos = await Promise.race([
      fetchDeviceLikedRecommendations(profile, countryCode, clientIp, ctx, 24, pageParam, forceRefresh, clientExcludeIds).catch(() => []),
      new Promise((resolve) => setTimeout(() => resolve([]), 8500))
    ]);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      success: true,
      deviceKey: key,
      countryCode,
      countryName: COUNTRY_NAMES[countryCode] || countryCode,
      countryFlag: COUNTRY_FLAGS[countryCode] || '🌍',
      clientIp,
      likedCount: profile.likes.length,
      likes: profile.likes.slice(0, 50),
      videos: relatedVideos
    }));
    return true;
  }

  // -----------------------------------------------------------------------
  // 1. RECOMENDAÇÕES INTELIGENTES DO CURADOR (/api/curator-recommendations)
  // -----------------------------------------------------------------------
  if (pathname === '/api/curator-recommendations') {
    const { profile } = getDeviceProfile(req, reqUrl, body, ctx);
    const type = body.type || reqUrl.searchParams.get('type') || 'youtube';
    const currentQuery = body.currentQuery || reqUrl.searchParams.get('q') || '';
    const currentTitle = body.currentTitle || reqUrl.searchParams.get('title') || '';
    const currentChannel = body.currentChannel || reqUrl.searchParams.get('channel') || '';
    const currentVideoId = body.currentVideoId || reqUrl.searchParams.get('videoId') || '';
    const rawExclude = (body && body.excludeTitles) || [];
    const excludeTitles = [
      ...(Array.isArray(rawExclude) ? rawExclude : []),
      ...(profile.dislikes || []).map((d) => d.id)
    ];
    const page = parseInt((body && body.page) || reqUrl.searchParams.get('page') || '1', 10) || 1;
    const stayOnTheme = (body && body.stayOnTheme === true) || reqUrl.searchParams.get('stayOnTheme') === 'true';
    const useAi = (body && body.useAi === true) || reqUrl.searchParams.get('useAi') === 'true';
    const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || (body && body.clientId) || 'client_default';
    const clientSession = ctx.getOrCreateClientSession(clientId);
    // YouTube scraping e recomendações utilizam conexão direta ultrarrápida (sem proxy Tor para evitar lentidão e bloqueios do YouTube)
    const useTor = false;

    const clientIpParam = reqUrl.searchParams.get('deviceIp') || (body && body.deviceIp) || req.headers['x-device-ip'] || req.headers['x-client-ip'] || '';
    const clientIp = ctx.extractRequestDeviceIp(req, clientIpParam);

    // O país deve ser rigorosamente determinado pelo IP da conexão atual do visitante
    const detectedCountryFromIp = await ctx.getClientCountryCode(req, clientIp, false).catch(() => 'BR');

    const clientCountryParam = (body && body.country) || reqUrl.searchParams.get('country') || '';
    const isManualCountry = (body && (body.isManualCountry === true || body.manualCountry === true))
      || reqUrl.searchParams.get('manual') === '1';

    let countryCode;
    // Se o usuário selecionou MANUALMENTE um país específico no seletor, respeita a escolha manual
    if (isManualCountry && clientCountryParam && /^[A-Z]{2}$/i.test(clientCountryParam) && clientCountryParam.toUpperCase() !== 'AUTO') {
      countryCode = clientCountryParam.toUpperCase();
    } else {
      // Caso contrário (modo Automático por padrão): utiliza SEMPRE o país onde o IP está conectado
      countryCode = detectedCountryFromIp;
    }

    // Se o usuário estiver rolando na aba "curtidos", alterna entre os vídeos curtidos a cada rolagem
    const isLikedTab = currentQuery === 'curtidos';
    const effectiveLikes = (profile && Array.isArray(profile.likes) && profile.likes.length > 0)
      ? profile.likes
      : [];

    let seedTitle = currentTitle;
    let seedChannel = currentChannel;
    let seedVideoId = currentVideoId;
    if (!seedVideoId && isLikedTab && effectiveLikes.length > 0) {
      const pick = effectiveLikes[(page - 1) % effectiveLikes.length];
      if (pick) {
        seedTitle = pick.title || seedTitle;
        seedChannel = pick.channel || seedChannel;
        seedVideoId = pick.id || seedVideoId;
      }
    }

    const reqTimeFilter = (body && body.timeFilter) || reqUrl.searchParams.get('time') || 'hour';

    // Scroll infinito na página de Filmes (/filmes): busca filmes completos (>= 25 min) no idioma e catálogo do país do IP
    if (type === 'cinema' || type === 'filmes') {
      const hl = ctx.getHlForCountry(countryCode);
      const langPrefix = String(hl || 'pt').split('-')[0].toLowerCase();
      const catOrQ = String((body && body.currentCategory) || currentQuery || 'todos').trim().toLowerCase();
      const safePage = Math.max(1, page);
      const currentYear = new Date().getFullYear();

      const cinemaPoolsByLang = {
        pt: {
          todos: [
            `filme completo dublado ${currentYear} lançamento`,
            `filmes completos dublados em portugues hd`,
            `filme de ação completo dublado 4k`,
            `filme de suspense completo dublado`,
            `filme de comédia completo dublado`,
            `filme de aventura completo dublado`
          ],
          acao: [
            `filme de ação completo dublado ${currentYear}`,
            `filme de ação e tiro completo dublado hd`,
            `filme policial completo dublado em portugues`,
            `filme de ação explosiva completo dublado`
          ],
          comedia: [
            `filme de comédia completo dublado ${currentYear}`,
            `comédia engraçada filme completo dublado`,
            `filme de humor familia completo dublado`
          ],
          terror: [
            `filme de terror completo dublado ${currentYear}`,
            `filme de terror sobrenatural completo dublado`,
            `terror pesado filme completo dublado hd`
          ],
          suspense: [
            `filme de suspense completo dublado ${currentYear}`,
            `suspense policial filme completo dublado`,
            `thriller psicologico filme completo dublado`
          ],
          ficcao: [
            `filme de ficção científica completo dublado ${currentYear}`,
            `filme futurista espacial completo dublado`,
            `ficção científica ação filme completo dublado`
          ],
          aventura: [
            `filme de aventura completo dublado ${currentYear}`,
            `filme épico aventura completo dublado hd`,
            `aventura fantasia filme completo dublado`
          ],
          animacao: [
            `filme de animação completo dublado ${currentYear}`,
            `desenho animado filme completo dublado em portugues`,
            `animação infantil familia filme completo dublado`
          ],
          luta: [
            `filme de artes marciais completo dublado ${currentYear}`,
            `filme de luta ação completo dublado hd`,
            `artes marciais torneio filme completo dublado`
          ]
        },
        en: {
          todos: [
            `full movie english ${currentYear} new release hd`,
            `free full movies in english hd`,
            `action full movie english 4k`,
            `thriller full movie in english`,
            `comedy full movie english hd`,
            `adventure full movie in english`
          ],
          acao: [
            `action full movie in english ${currentYear} hd`,
            `action thriller full movie english`,
            `crime action full movie free english`
          ],
          comedia: [
            `comedy full movie in english ${currentYear} hd`,
            `funny comedy full movie english`,
            `family comedy full movie in english`
          ],
          terror: [
            `horror full movie in english ${currentYear} hd`,
            `scary supernatural horror full movie english`,
            `thriller horror full movie in english`
          ],
          suspense: [
            `thriller suspense full movie in english ${currentYear}`,
            `mystery crime thriller full movie english`,
            `psychological thriller full movie english hd`
          ],
          ficcao: [
            `sci-fi full movie in english ${currentYear} hd`,
            `science fiction space full movie english`,
            `futuristic sci fi action full movie english`
          ],
          aventura: [
            `adventure full movie in english ${currentYear} hd`,
            `epic fantasy adventure full movie english`,
            `survival adventure full movie in english`
          ],
          animacao: [
            `animated full movie in english ${currentYear} hd`,
            `family animation full movie english`,
            `cartoon movie full length english`
          ],
          luta: [
            `martial arts full movie in english ${currentYear} hd`,
            `kung fu fighting action full movie english`,
            `combat tournament full movie in english`
          ]
        },
        es: {
          todos: [
            `pelicula completa en español ${currentYear} estreno hd`,
            `peliculas completas en español latino hd`,
            `pelicula de accion completa en español`,
            `pelicula de suspenso completa en español`,
            `pelicula de comedia completa en español`
          ],
          acao: [
            `pelicula de accion completa en español ${currentYear} hd`,
            `accion y tiros pelicula completa en español latino`,
            `pelicula policial de accion completa en español`
          ],
          comedia: [
            `pelicula de comedia completa en español ${currentYear}`,
            `comedia divertida pelicula completa en español latino`
          ],
          terror: [
            `pelicula de terror completa en español ${currentYear} hd`,
            `terror paranormal pelicula completa en español`
          ],
          suspense: [
            `pelicula de suspenso completa en español ${currentYear}`,
            `thriller misterio pelicula completa en español`
          ],
          ficcao: [
            `pelicula de ciencia ficcion completa en español ${currentYear}`,
            `ciencia ficcion accion pelicula completa en español`
          ],
          aventura: [
            `pelicula de aventura completa en español ${currentYear} hd`,
            `aventura epica pelicula completa en español`
          ],
          animacao: [
            `pelicula animada completa en español ${currentYear}`,
            `animacion familiar pelicula completa en español latino`
          ],
          luta: [
            `pelicula de artes marciales completa en español ${currentYear}`,
            `peleas accion pelicula completa en español`
          ]
        },
        fr: {
          todos: [
            `film complet en français ${currentYear} nouveauté hd`,
            `films complets en français vf hd`,
            `film d'action complet en français`,
            `film thriller suspense complet en français`
          ],
          acao: [`film d'action complet en français ${currentYear} hd`, `film policier action complet vf`],
          comedia: [`film comédie complet en français ${currentYear}`, `comédie française film complet vf`],
          terror: [`film d'horreur complet en français ${currentYear}`, `film épouvante horreur complet vf`],
          suspense: [`film thriller suspense complet en français ${currentYear}`, `film mystère policier complet vf`],
          ficcao: [`film science fiction complet en français ${currentYear}`, `film fantastique sci-fi complet vf`],
          aventura: [`film d'aventure complet en français ${currentYear}`, `film aventure épique complet vf`],
          animacao: [`film d'animation complet en français ${currentYear}`, `dessin animé film complet vf`],
          luta: [`film arts martiaux complet en français ${currentYear}`, `film de combat action complet vf`]
        },
        de: {
          todos: [
            `ganzer film deutsch ${currentYear} neu hd`,
            `filme komplett auf deutsch in voller länge`,
            `actionfilm ganzer film deutsch hd`,
            `thriller ganzer film deutsch`
          ],
          acao: [`actionfilm ganzer film deutsch ${currentYear} hd`, `action krimi ganzer film auf deutsch`],
          comedia: [`komödie ganzer film deutsch ${currentYear}`, `lustiger familienfilm ganzer film deutsch`],
          terror: [`horrorfilm ganzer film deutsch ${currentYear}`, `gruselfilm komplett auf deutsch`],
          suspense: [`thriller spannung ganzer film deutsch ${currentYear}`, `krimi thriller ganzer film auf deutsch`],
          ficcao: [`science fiction ganzer film deutsch ${currentYear}`, `sci-fi film komplett auf deutsch`],
          aventura: [`abenteuerfilm ganzer film deutsch ${currentYear}`, `fantasy abenteuer film komplett deutsch`],
          animacao: [`animationsfilm ganzer film deutsch ${currentYear}`, `zeichentrickfilm komplett auf deutsch`],
          luta: [`martial arts kampffilm ganzer film deutsch ${currentYear}`, `kung fu action ganzer film deutsch`]
        },
        it: {
          todos: [
            `film completo in italiano ${currentYear} hd`,
            `film completi in italiano gratis`,
            `film d'azione completo in italiano`,
            `film thriller completo in italiano`
          ],
          acao: [`film d'azione completo in italiano ${currentYear} hd`, `film poliziesco azione completo italiano`],
          comedia: [`film commedia completo in italiano ${currentYear}`, `commedia divertente film completo italiano`],
          terror: [`film horror completo in italiano ${currentYear}`, `film paura horror completo italiano`],
          suspense: [`film thriller suspense completo in italiano ${currentYear}`, `film giallo mistero completo italiano`],
          ficcao: [`film fantascienza completo in italiano ${currentYear}`, `film sci-fi azione completo italiano`],
          aventura: [`film avventura completo in italiano ${currentYear}`, `film epico avventura completo italiano`],
          animacao: [`film d'animazione completo in italiano ${currentYear}`, `cartone animato film completo italiano`],
          luta: [`film arti marziali completo in italiano ${currentYear}`, `film combattimento azione completo italiano`]
        }
      };

      const langKey = (countryCode === 'BR' || countryCode === 'PT' || langPrefix === 'pt')
        ? 'pt'
        : (cinemaPoolsByLang[langPrefix] ? langPrefix : 'en');
      const poolMap = cinemaPoolsByLang[langKey] || cinemaPoolsByLang.en;
      const catPool = poolMap[catOrQ] || null;

      let queriesToRun = [];
      if (catPool && catPool.length > 0) {
        const q1 = catPool[(safePage - 1) % catPool.length];
        const q2 = catPool[safePage % catPool.length];
        queriesToRun = q1 === q2 ? [q1] : [q1, q2];
      } else {
        const suffixMap = {
          pt: 'filme completo dublado',
          en: 'full movie in english',
          es: 'pelicula completa en español',
          fr: 'film complet en français',
          de: 'ganzer film deutsch',
          it: 'film completo in italiano'
        };
        const suf = suffixMap[langKey] || suffixMap.en;
        queriesToRun = [`${currentQuery || catOrQ} ${suf}`, `${currentQuery || catOrQ} ${suf} ${currentYear}`];
      }

      const excludeSet = new Set(excludeTitles.map((x) => String(x || '').toLowerCase()));
      const searchLists = await Promise.all(
        queriesToRun.map((qStr) => ctx.searchYoutubeVideos(qStr, hl, false, '', false, '', countryCode, clientIp).catch(() => []))
      );

      const parseDur = typeof ctx.parseDurationToSeconds === 'function'
        ? ctx.parseDurationToSeconds
        : (dur) => {
            if (!dur) return 0;
            const p = String(dur).trim().split(':').map(Number);
            if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
            if (p.length === 2) return p[0] * 60 + p[1];
            return p[0] || 0;
          };

      const movies = [];
      for (const list of searchLists) {
        for (const v of list || []) {
          if (!v || !v.id) continue;
          const idLow = String(v.id).toLowerCase();
          if (excludeSet.has(idLow)) continue;
          const secs = parseDur(v.duration);
          if (secs >= 1500) {
            excludeSet.add(idLow);
            movies.push(v);
          }
        }
      }
      if (movies.length < 8) {
        for (const list of searchLists) {
          for (const v of list || []) {
            if (!v || !v.id) continue;
            const idLow = String(v.id).toLowerCase();
            if (excludeSet.has(idLow)) continue;
            const secs = parseDur(v.duration);
            if (secs >= 600 || !v.duration) {
              excludeSet.add(idLow);
              movies.push(v);
            }
          }
        }
      }

      const reasonByLang = {
        pt: '🍿 Mais filmes completos dublados selecionados para você',
        en: '🍿 More full-length movies selected for your region',
        es: '🍿 Más películas completas en español seleccionadas para ti',
        fr: '🍿 Plus de films complets en français sélectionnés pour vous',
        de: '🍿 Weitere ganze Filme auf Deutsch für Sie ausgewählt',
        it: '🍿 Altri film completi in italiano selezionati per te'
      };

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        countryCode,
        countryName: COUNTRY_NAMES[countryCode] || countryCode,
        countryFlag: COUNTRY_FLAGS[countryCode] || '🌍',
        clientIp,
        reason: `${COUNTRY_FLAGS[countryCode] || '🌍'} ${reasonByLang[langKey] || reasonByLang.en}`,
        items: movies.slice(0, 24)
      }));
      return true;
    }

    // Scroll infinito no tema Notícias (sem vídeo em reprodução): continua misturando os principais canais de jornalismo, Google Trends e buscas dinâmicas
    const isNewsScroll = !isLikedTab && !currentVideoId && !currentTitle
      && typeof ctx.isNewsYoutubeCategory === 'function' && ctx.isNewsYoutubeCategory(currentQuery || 'noticias')
      && typeof ctx.fetchMixedNewsVideos === 'function';
    if (isNewsScroll) {
      const excludeLow = new Set(excludeTitles.map((x) => String(x || '').toLowerCase()));
      const safePage = Math.max(1, page);
      const newsVideos = await ctx.fetchMixedNewsVideos({
        timeFilter: reqTimeFilter,
        country: countryCode,
        clientIp,
        page: safePage
      }).catch(() => []);
      let fresh = (newsVideos || []).filter((v) => v && v.id && !excludeLow.has(String(v.id).toLowerCase()));

      // Se vieram menos de 16 vídeos inéditos das fontes fixas, complementa dinamicamente
      if (fresh.length < 16) {
        const freshSeen = new Set([...excludeLow, ...fresh.map((v) => String(v.id).toLowerCase())]);
        const hl = ctx.getHlForCountry(countryCode);

        // 1. Tópicos em alta do Google Trends (somente vídeos recentes de hoje/semana)
        if (typeof ctx.fetchGoogleTrends === 'function') {
          const trends = await ctx.fetchGoogleTrends(countryCode).catch(() => []);
          if (Array.isArray(trends) && trends.length > 0) {
            const startTrend = ((safePage - 1) * 3) % trends.length;
            const topTrends = trends.slice(startTrend, startTrend + 4);
            const checkOld = typeof ctx.isOldYoutubeVideo === 'function'
              ? ctx.isOldYoutubeVideo
              : (v) => /\b\d+\s*(?:y|yr|yrs|year|years|ano|anos|a[ñn]o|a[ñn]os|mo|mos|month|months|m[eê]s|meses|mois|monat|monate|monaten|mese|mesi)\b/i.test(String(v && v.publishedAt || ''));
            const trendResults = await Promise.all(
              topTrends.map(async (t) => {
                let list = await ctx.searchYoutubeVideos(t.title, hl, true, 'day', false, 'news', countryCode, clientIp).catch(() => []);
                list = (list || []).filter((v) => !checkOld(v, 7));
                if (list.length === 0) {
                  const retry = await ctx.searchYoutubeVideos(t.title, hl, true, 'week', false, 'news', countryCode, clientIp).catch(() => []);
                  list = (retry || []).filter((v) => !checkOld(v, 14));
                }
                return { trend: t, videos: list.slice(0, 2) };
              })
            );
            for (const entry of trendResults) {
              const t = entry.trend;
              for (const v of entry.videos || []) {
                if (v && v.id && !freshSeen.has(String(v.id).toLowerCase())) {
                  freshSeen.add(String(v.id).toLowerCase());
                  fresh.push({
                    ...v,
                    isGoogleTrend: true,
                    trendTopic: t.title,
                    trendTraffic: t.traffic,
                    trendHeadline: t.newsTitle
                  });
                  if (fresh.length >= 24) break;
                }
              }
              if (fresh.length >= 24) break;
            }
          }
        }

        // 2. Termos rotacionados para a página do scroll
        if (fresh.length < 16 && typeof ctx.rotateThemeSearchQueries === 'function') {
          const rotated = ctx.rotateThemeSearchQueries('noticias', safePage, countryCode);
          const extraTerms = (rotated.queries || []).filter(Boolean);
          const extraResults = await Promise.all(
            extraTerms.slice(0, 3).map((term) => ctx.searchYoutubeVideos(term, hl, true, 'day', false, 'news', countryCode, clientIp).catch(() => []))
          );
          for (const list of extraResults) {
            for (const v of list || []) {
              if (v && v.id && !freshSeen.has(String(v.id).toLowerCase())) {
                freshSeen.add(String(v.id).toLowerCase());
                fresh.push(v);
                if (fresh.length >= 24) break;
              }
            }
            if (fresh.length >= 24) break;
          }
        }

        // 3. Fallback de emergência com termo dinâmico de notícias do país
        if (fresh.length < 12) {
          const isPtCountry = countryCode === 'BR' || countryCode === 'PT';
          const emergencyQuery = isPtCountry
            ? `noticias ${countryCode === 'PT' ? 'portugal' : 'brasil'} hoje ultimas 2026`
            : `breaking news today ${COUNTRY_NAMES[countryCode] || countryCode} 2026`;
          const emergencyList = await ctx.searchYoutubeVideos(emergencyQuery, hl, true, 'day', false, 'news', countryCode, clientIp).catch(() => []);
          for (const v of emergencyList || []) {
            if (v && v.id && !freshSeen.has(String(v.id).toLowerCase())) {
              freshSeen.add(String(v.id).toLowerCase());
              fresh.push(v);
              if (fresh.length >= 24) break;
            }
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        countryCode,
        countryName: COUNTRY_NAMES[countryCode] || countryCode,
        countryFlag: COUNTRY_FLAGS[countryCode] || '🌍',
        clientIp,
        reason: 'Mais notícias dos principais canais de jornalismo e temas em alta',
        items: filterAndRankVideosForDevice(fresh, profile).slice(0, 24)
      }));
      return true;
    }

    // Se for na aba Curtidos, aproveita a rotação rica de recomendações baseadas nas curtidas
    if (isLikedTab) {
      const likedRel = await fetchDeviceLikedRecommendations(profile, countryCode, clientIp, ctx, 24, page, false);
      const excludeLow = new Set(excludeTitles.map((x) => String(x || '').toLowerCase()));
      const fresh = (likedRel || []).filter((v) => v && v.id && !excludeLow.has(String(v.id).toLowerCase()));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        countryCode,
        countryName: COUNTRY_NAMES[countryCode] || countryCode,
        countryFlag: COUNTRY_FLAGS[countryCode] || '🌍',
        clientIp,
        reason: 'Mais recomendações personalizadas com base nas suas curtidas',
        items: filterAndRankVideosForDevice(fresh, profile).slice(0, 24)
      }));
      return true;
    }

    // Scroll infinito para qualquer categoria/tema (financeiro, criptomoedas, esportes, etc.) sem vídeo em reprodução
    const isThemeScroll = !isLikedTab && !currentVideoId && !currentTitle && currentQuery;
    if (isThemeScroll) {
      const excludeLow = new Set(excludeTitles.map((x) => String(x || '').toLowerCase()));
      const safePage = Math.max(1, page);
      const hl = ctx.getHlForCountry(countryCode);
      const rotated = (typeof ctx.rotateThemeSearchQueries === 'function')
        ? ctx.rotateThemeSearchQueries(currentQuery, safePage, countryCode)
        : { queries: [currentQuery], searchMode: '' };

      const searchTerms = (rotated.queries || []).filter(Boolean);
      // No scroll infinito (página 2+), usa filtro 'day' para garantir volume abundante de vídeos recentes sem vir vazio
      const effectiveTimeFilter = reqTimeFilter === 'hour' ? 'day' : reqTimeFilter;
      // Busca em paralelo todos os termos rotacionados para esta página
      const searchPromises = searchTerms.map((term) =>
        ctx.searchYoutubeVideos(term, hl, true, effectiveTimeFilter, false, rotated.searchMode, countryCode, clientIp).catch(() => [])
      );

      const results = await Promise.all(searchPromises);
      const seenIds = new Set(excludeLow);
      const fresh = [];
      for (const list of results) {
        for (const v of list || []) {
          if (v && v.id && !seenIds.has(String(v.id).toLowerCase())) {
            seenIds.add(String(v.id).toLowerCase());
            fresh.push(v);
            if (fresh.length >= 24) break;
          }
        }
        if (fresh.length >= 24) break;
      }

      // Se ainda vieram menos de 16 vídeos, tenta busca complementar com filtro 'day' e termos relacionados
      if (fresh.length < 16) {
        const fallbackTerm = `${currentQuery} mercado noticias 2026`;
        const extraList = await ctx.searchYoutubeVideos(fallbackTerm, hl, false, 'day', false, rotated.searchMode, countryCode, clientIp).catch(() => []);
        for (const v of extraList || []) {
          if (v && v.id && !seenIds.has(String(v.id).toLowerCase())) {
            seenIds.add(String(v.id).toLowerCase());
            fresh.push(v);
            if (fresh.length >= 24) break;
          }
        }
      }
      if (fresh.length < 12) {
        const extraList2 = await ctx.searchYoutubeVideos(`${currentQuery} novidades`, hl, false, '', false, rotated.searchMode, countryCode, clientIp).catch(() => []);
        for (const v of extraList2 || []) {
          if (v && v.id && !seenIds.has(String(v.id).toLowerCase())) {
            seenIds.add(String(v.id).toLowerCase());
            fresh.push(v);
            if (fresh.length >= 24) break;
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        countryCode,
        countryName: COUNTRY_NAMES[countryCode] || countryCode,
        countryFlag: COUNTRY_FLAGS[countryCode] || '🌍',
        clientIp,
        reason: `Mais vídeos sobre "${currentQuery}"`,
        items: filterAndRankVideosForDevice(fresh, profile).slice(0, 24)
      }));
      return true;
    }

    // Em paralelo, se houver curtida disponível, busca de uma 2ª semente para dobrar a variedade no scroll
    const secondSeedPromise = (effectiveLikes.length > 1)
      ? (() => {
          const pick2 = effectiveLikes[page % effectiveLikes.length];
          if (!pick2 || pick2.id === seedVideoId) return Promise.resolve(null);
          return ctx.getAiCuratorSuggestions({
            type,
            currentQuery: '',
            currentTitle: pick2.title || '',
            currentChannel: pick2.channel || '',
            currentVideoId: pick2.id || '',
            excludeTitles,
            page,
            stayOnTheme: true,
            useAi: false,
            useTor: false,
            country: countryCode,
            clientIp,
            timeFilter: reqTimeFilter
          }).catch(() => null);
        })()
      : Promise.resolve(null);

    const [result, secondResult] = await Promise.all([
      ctx.getAiCuratorSuggestions({
        type,
        currentQuery: isLikedTab ? '' : currentQuery,
        currentTitle: seedTitle,
        currentChannel: seedChannel,
        currentVideoId: seedVideoId,
        excludeTitles,
        page,
        stayOnTheme: true,
        useAi,
        useTor: false,
        country: countryCode,
        clientIp,
        timeFilter: reqTimeFilter
      }),
      secondSeedPromise
    ]);

    let combinedItems = (result && Array.isArray(result.items)) ? result.items.slice() : [];
    if (secondResult && Array.isArray(secondResult.items)) {
      const seenSet = new Set(combinedItems.map((v) => v && v.id).filter(Boolean));
      for (const item of secondResult.items) {
        if (item && item.id && !seenSet.has(item.id)) {
          seenSet.add(item.id);
          combinedItems.push(item);
        }
      }
    }

    // Se ainda houver menos de 16 vídeos e o dispositivo tiver curtidas próprias, complementa com recomendações deste dispositivo
    if (combinedItems.length < 16 && effectiveLikes.length > 0) {
      const cacheSig = `${countryCode}_p1_${effectiveLikes.slice(0, 5).map((x) => x && x.id).join(',')}`;
      const devCached = likedRecsCache.get(cacheSig);
      if (devCached && Array.isArray(devCached.items)) {
        const excludeIdsSet = new Set([...excludeTitles.map((x) => String(x).toLowerCase()), ...combinedItems.map((v) => String(v && v.id).toLowerCase())]);
        for (const item of devCached.items) {
          if (item && item.id && !excludeIdsSet.has(String(item.id).toLowerCase())) {
            excludeIdsSet.add(String(item.id).toLowerCase());
            combinedItems.push(item);
            if (combinedItems.length >= 24) break;
          }
        }
      }
    }

    // Se vierem menos de 12 vídeos ao reproduzir vídeo, complementa com vídeos do canal ou assunto relacionado
    if (combinedItems.length < 12) {
      const excludeLow = new Set([...excludeTitles.map((x) => String(x || '').toLowerCase()), ...combinedItems.map((v) => String(v && v.id).toLowerCase())]);
      const hl = ctx.getHlForCountry(countryCode);
      const backupKeywords = seedTitle ? (typeof ctx.extractRelatedKeywords === 'function' ? ctx.extractRelatedKeywords(seedTitle, seedChannel) : seedTitle) : '';
      const backupQuery = (seedChannel ? `${seedChannel} ${backupKeywords || 'novos'}` : (backupKeywords || currentQuery || 'noticias')).trim();
      const extraList = await ctx.searchYoutubeVideos(backupQuery + ' 2026', hl, false, '', false, '', countryCode, clientIp).catch(() => []);
      for (const v of extraList || []) {
        if (v && v.id && !excludeLow.has(String(v.id).toLowerCase())) {
          excludeLow.add(String(v.id).toLowerCase());
          combinedItems.push(v);
          if (combinedItems.length >= 24) break;
        }
      }
    }

    if (combinedItems.length === 0 && typeof ctx.fetchTrendingVideos === 'function') {
      const trend = await ctx.fetchTrendingVideos({ country: countryCode, clientIp }).catch(() => []);
      combinedItems = (trend || []).slice(0, 24);
    }

    if (combinedItems.length > 0) {
      combinedItems = filterAndRankVideosForDevice(combinedItems, profile).slice(0, 24);
    }
    if (result) {
      result.items = combinedItems;
      result.countryCode = countryCode;
      result.countryName = COUNTRY_NAMES[countryCode] || countryCode;
      result.countryFlag = COUNTRY_FLAGS[countryCode] || '🌍';
      result.clientIp = clientIp;
    }

    // Pré-aquece a próxima página (page + 1) em segundo plano para que a próxima rolagem seja instantânea
    setTimeout(() => {
      const nextPick = effectiveLikes.length > 0 ? effectiveLikes[page % effectiveLikes.length] : null;
      ctx.getAiCuratorSuggestions({
        type,
        currentQuery: isLikedTab ? '' : currentQuery,
        currentTitle: (nextPick && nextPick.title) || seedTitle,
        currentChannel: (nextPick && nextPick.channel) || seedChannel,
        currentVideoId: (nextPick && nextPick.id) || seedVideoId,
        excludeTitles: [...excludeTitles, ...combinedItems.map((v) => v && v.id).filter(Boolean)],
        page: page + 1,
        stayOnTheme: true,
        useAi: false,
        useTor: false,
        country: countryCode,
        clientIp,
        timeFilter: reqTimeFilter
      }).catch(() => {});
    }, 80);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return true;
  }

  // -----------------------------------------------------------------------
  // 2. DETECÇÃO DE PAÍS DO CLIENTE (/api/country-detect)
  // -----------------------------------------------------------------------
  if (pathname === '/api/country-detect') {
    try {
      const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || 'client_default';
      const clientSession = ctx.getOrCreateClientSession(clientId);
      const useTor = ctx.isTorRoutingEnabled(clientSession);
      const clientIpParam = reqUrl.searchParams.get('deviceIp') || req.headers['x-device-ip'] || req.headers['x-client-ip'] || '';
      const clientIp = ctx.extractRequestDeviceIp(req, clientIpParam);
      const country = await ctx.getClientCountryCode(req, clientIp, false);
      let effectiveIp = clientIp;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        success: true,
        country,
        clientIp: effectiveIp,
        torActive: useTor,
        name: COUNTRY_NAMES[country] || country,
        flag: COUNTRY_FLAGS[country] || '🌍'
      }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, country: 'BR', name: 'Brasil', flag: '🇧🇷', torActive: false }));
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // 2.1 AUTOCOMPLETE & SUGESTÕES DE BUSCA DO YOUTUBE (/api/youtube-suggest)
  // -----------------------------------------------------------------------
  if (pathname === '/api/youtube-suggest' || pathname === '/api/suggest') {
    const q = String(reqUrl.searchParams.get('q') || '').trim();
    if (!q || q.length < 2) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      res.end(JSON.stringify({ success: true, q: '', suggestions: [] }));
      return true;
    }
    const country = (reqUrl.searchParams.get('country') || 'BR').toUpperCase();
    const hl = country === 'BR' ? 'pt-BR' : (country === 'PT' ? 'pt-PT' : 'en');

    if (!global.__plYtSuggestCache) {
      global.__plYtSuggestCache = new Map();
    }
    const cacheKey = `${country}:${q.toLowerCase()}`;
    const cached = global.__plYtSuggestCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      res.end(JSON.stringify({ success: true, q, suggestions: cached.suggestions }));
      return true;
    }

    try {
      const suggestUrl = `https://suggestqueries.google.com/complete/search?client=firefox&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(country)}&ds=yt&q=${encodeURIComponent(q)}`;
      const suggestRes = await fetch(suggestUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(2500)
      }).catch(() => null);

      let suggestions = [];
      if (suggestRes && suggestRes.ok) {
        const rawJson = await suggestRes.json().catch(() => null);
        if (Array.isArray(rawJson) && Array.isArray(rawJson[1])) {
          suggestions = rawJson[1].slice(0, 8);
        }
      }

      // Se vier vazio, tenta complementar com tópicos do Google Trends com match parcial
      if (suggestions.length === 0 && typeof ctx.getCachedGoogleTrends === 'function') {
        const trends = ctx.getCachedGoogleTrends(country) || [];
        const qLow = q.toLowerCase();
        for (const t of trends) {
          if (t && t.title && t.title.toLowerCase().includes(qLow)) {
            suggestions.push(t.title);
            if (suggestions.length >= 6) break;
          }
        }
      }

      if (global.__plYtSuggestCache.size > 200) {
        const firstKey = global.__plYtSuggestCache.keys().next().value;
        if (firstKey) global.__plYtSuggestCache.delete(firstKey);
      }
      global.__plYtSuggestCache.set(cacheKey, { ts: Date.now(), suggestions });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      res.end(JSON.stringify({ success: true, q, suggestions }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, q, suggestions: [] }));
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // 3. VÍDEOS EM ALTA & RECENTES (/api/youtube-trending, /api/youtube-recent)
  // -----------------------------------------------------------------------
  if (pathname === '/api/youtube-trending' || pathname === '/api/youtube-recent') {
    const { profile } = getDeviceProfile(req, reqUrl, body, ctx);
    const clientId = req.headers['x-client-id'] || reqUrl.searchParams.get('clientId') || 'client_default';
    const clientSession = ctx.getOrCreateClientSession(clientId);
    // Buscas e recomendações do YouTube saem direto (sem Tor) na velocidade máxima da internet
    const useTor = false;
    const qParam = reqUrl.searchParams.get('q') || '';
    const clientCountryParam = reqUrl.searchParams.get('country') || '';
    const clientIpParam = reqUrl.searchParams.get('deviceIp') || req.headers['x-device-ip'] || req.headers['x-client-ip'] || '';
    const clientIp = ctx.extractRequestDeviceIp(req, clientIpParam);

    const isManualCountry = reqUrl.searchParams.get('manual') === '1';

    // O país deve ser rigorosamente determinado pelo IP da conexão atual do visitante
    const detectedCountryFromIp = await ctx.getClientCountryCode(req, clientIp, false).catch(() => 'BR');

    let countryCode;
    if (isManualCountry && clientCountryParam && /^[A-Z]{2}$/i.test(clientCountryParam) && clientCountryParam.toUpperCase() !== 'AUTO') {
      countryCode = clientCountryParam.toUpperCase();
    } else {
      countryCode = detectedCountryFromIp;
    }

    const hl = ctx.getHlForCountry(countryCode);
    const effectiveClientIp = useTor ? '' : clientIp;

    // Se a categoria selecionada for "curtidos" / "para voce", traz o feed focado exclusivamente nas curtidas do dispositivo
    if (/^(curtidos|para\s*voce|para\s*você)$/i.test(qParam.trim())) {
      if (!profile || !Array.isArray(profile.likes) || profile.likes.length === 0) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
        });
        res.end(JSON.stringify({
          success: true,
          countryCode,
          countryName: COUNTRY_NAMES[countryCode] || countryCode,
          countryFlag: COUNTRY_FLAGS[countryCode] || '🌍',
          clientIp: effectiveClientIp,
          query: 'curtidos',
          likedCount: 0,
          videos: []
        }));
        return true;
      }
      let likedRel = await fetchDeviceLikedRecommendations(profile, countryCode, effectiveClientIp, ctx, 24, parseInt(reqUrl.searchParams.get('page') || '1', 10), reqUrl.searchParams.get('refresh') === '1');
      const seenL = new Set(likedRel.map((v) => v && v.id));
      for (const lk of (profile.likes || [])) {
        if (lk && lk.id && !seenL.has(lk.id)) {
          seenL.add(lk.id);
          likedRel.push({ ...lk, liked: true, relatedToLiked: true });
        }
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
      });
      res.end(JSON.stringify({
        success: true,
        countryCode,
        countryName: COUNTRY_NAMES[countryCode] || countryCode,
        countryFlag: COUNTRY_FLAGS[countryCode] || '🌍',
        clientIp: effectiveClientIp,
        query: 'curtidos',
        likedCount: (profile.likes || []).length,
        videos: likedRel.slice(0, 30)
      }));
      return true;
    }

    // Dispara em paralelo recomendações baseadas nas curtidas deste dispositivo (se houver)
    const shouldIncludeLiked = profile && Array.isArray(profile.likes) && profile.likes.length > 0 && reqUrl.searchParams.get('includeLiked') !== '0';
    const likedRecommendationsPromise = shouldIncludeLiked
      ? Promise.race([
          fetchDeviceLikedRecommendations(profile, countryCode, effectiveClientIp, ctx, 8).catch(() => []),
          new Promise((resolve) => setTimeout(() => resolve([]), 450))
        ])
      : Promise.resolve([]);

    const forceCustom = reqUrl.searchParams.get('custom') === '1' || (qParam && qParam.trim().split(/\s+/).length > 2);
    const pageParam = parseInt(reqUrl.searchParams.get('page') || '1', 10);
    let { query: dynamicQuery, sortByRecent, isCustomQuery, searchMode } = ctx.getDynamicRecentYoutubeQuery(qParam || 'noticias', forceCustom, countryCode);
    if (pageParam > 1) {
      const rotated = ctx.rotateThemeSearchQueries(qParam || 'noticias', pageParam, countryCode);
      if (rotated.queries && rotated.queries[0]) dynamicQuery = rotated.queries[0];
      if (rotated.searchMode) searchMode = rotated.searchMode;
      sortByRecent = true;
    }
    // Por padrão, sempre busca vídeos relacionados ao tema nas últimas horas ('hour')
    let timeFilter = reqUrl.searchParams.get('time') || 'hour';
    if (timeFilter !== 'none') {
      sortByRecent = true;
    } else {
      sortByRecent = false;
    }

    if (!global.__plRecentFeedFastCache) {
      global.__plRecentFeedFastCache = new Map();
    }
    const recentFeedFastCache = global.__plRecentFeedFastCache;
    const isForceRefresh = reqUrl.searchParams.get('refresh') === '1';
    const fastCacheKey = `${countryCode}:${(qParam || 'noticias').trim().toLowerCase()}:${timeFilter}:${pageParam}`;
    // Guarda o feed anterior: se a atualização forçada demorar demais, ele é devolvido na hora
    // (e o feed novo continua sendo buscado em segundo plano, populando o cache para o próximo toque).
    const staleFeedBeforeRefresh = isForceRefresh ? recentFeedFastCache.get(fastCacheKey) : null;
    if (isForceRefresh) {
      recentFeedFastCache.delete(fastCacheKey);
      // Limpar TODOS os caches do YouTube é caro (deixa as próximas buscas de todos os usuários lentas):
      // limita a no máximo uma limpeza global a cada 60s.
      const nowTs = Date.now();
      if (typeof ctx.clearYoutubeCaches === 'function' && nowTs - (global.__plLastYtCacheClear || 0) > 60000) {
        global.__plLastYtCacheClear = nowTs;
        try { ctx.clearYoutubeCaches(); } catch (e) { swallowed(e, 'curator:handle@1684'); }
      }
    }

    const countryRelevanceFilter = (typeof ctx.filterVideosByCountryRelevance === 'function')
      ? ctx.filterVideosByCountryRelevance
      : (vList, cCode) => {
          if (!Array.isArray(vList) || vList.length === 0) return [];
          const c = String(cCode || 'BR').toUpperCase();
          if (c === 'BR' || c === 'PT') {
            const foreignSpanishRegex = /(?:[¿¡]|\ben España\b|\ben espana\b|\bmerece la pena\b|\bcuánto cuesta\b|\bcuanto cuesta\b|\blo que hace\b|\blo que falla\b|\bte contamos qué es\b|\bsuscríbete\b|\ben directo\b|\bde la jornada\b|\bel resumen\b|\blos goles de\b|\ben vivo noticias\b|\bprobamos\b|\bpara qué sirve\b)/i;
            const localVideos = [];
            const foreignVideos = [];
            for (const v of vList) {
              if (!v) continue;
              const text = `${v.title || ''} ${v.description || ''} ${v.channel || ''}`;
              if (foreignSpanishRegex.test(text)) {
                foreignVideos.push(v);
              } else {
                localVideos.push(v);
              }
            }
            return localVideos.length >= 4 ? localVideos : [...localVideos, ...foreignVideos];
          }
          return vList;
        };

    const checkOldVideo = typeof ctx.isOldYoutubeVideo === 'function'
      ? ctx.isOldYoutubeVideo
      : (v) => /\b\d+\s*(?:y|yr|yrs|year|years|ano|anos|a[ñn]o|a[ñn]os|mo|mos|month|months|m[eê]s|meses|mois|monat|monate|monaten|mese|mesi)\b/i.test(String(v && v.publishedAt || ''));

    const searchFreshTrendVideos = async (trendItem, mode = 'news') => {
      const effectiveMode = mode === 'trending' ? 'news' : mode;
      // Cada tópico do Google Trends tem tempo limite próprio para não segurar o feed inteiro
      const withDeadline = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve([]), ms))]);
      let resList = await withDeadline(ctx.searchYoutubeVideos(trendItem.title, hl, true, 'day', useTor, effectiveMode, countryCode, effectiveClientIp).catch(() => []), 3500);
      resList = (resList || []).filter((v) => !checkOldVideo(v, 7));
      if (resList.length === 0) {
        const retry = await withDeadline(ctx.searchYoutubeVideos(trendItem.title, hl, true, 'week', useTor, effectiveMode, countryCode, effectiveClientIp).catch(() => []), 2000);
        resList = (retry || []).filter((v) => !checkOldVideo(v, 14));
      }
      return resList.slice(0, 2).map((v) => ({
        ...v,
        isGoogleTrend: true,
        trendTopic: trendItem.title,
        trendTraffic: trendItem.traffic,
        trendHeadline: trendItem.newsTitle
      }));
    };

    const fetchFreshFeedVideos = async () => {
      let freshVideos = [];
      const feedWait = useTor ? 14000 : 4500;
      const extraWait = useTor ? 7000 : 2500;
      try {
        const isNewsTheme = !isCustomQuery && typeof ctx.isNewsYoutubeCategory === 'function' && ctx.isNewsYoutubeCategory(qParam || 'noticias') && typeof ctx.fetchMixedNewsVideos === 'function';
        if (isNewsTheme) {
          // Tema Notícias: mistura os principais canais de jornalismo com os tópicos em alta do Google Trends
          const newsPromise = ctx.fetchMixedNewsVideos({
            timeFilter,
            country: countryCode,
            clientIp: effectiveClientIp,
            page: pageParam,
            forceRefresh: isForceRefresh
          }).catch(() => []);

          const googleTrendsPromise = (typeof ctx.fetchGoogleTrends === 'function')
            ? ctx.fetchGoogleTrends(countryCode, isForceRefresh).catch(() => [])
            : Promise.resolve([]);

          const [newsVideos, googleTrendsList] = await Promise.all([
            newsPromise,
            googleTrendsPromise
          ]);

          let trendVideos = [];
          if (Array.isArray(googleTrendsList) && googleTrendsList.length > 0) {
            // Busca vídeos mais recentes dos 6 tópicos líderes do Google Trends para intercalar com as notícias
            const topQueries = googleTrendsList.slice(0, 6);
            const trendResults = await Promise.all(
              topQueries.map((t) => searchFreshTrendVideos(t, 'news'))
            );
            trendVideos = trendResults.flat();
          }

          // Intercala os vídeos em alta do Google Trends harmonicamente junto com as notícias
          const seen = new Set();
          const combined = [];
          let baseNews = Array.isArray(newsVideos) ? newsVideos.slice() : [];
          if (baseNews.length < 6) {
            const isBr = countryCode === 'BR' || countryCode === 'PT';
            const fallbackQuery = isBr
              ? 'noticias brasil hoje jornalismo g1 record sbt jovem pan cnn'
              : 'breaking news today world latest headlines live stream';
            const extra = await ctx.searchYoutubeVideos(fallbackQuery, hl, true, 'day', useTor, 'news', countryCode, effectiveClientIp).catch(() => []);
            const seenNewsIds = new Set(baseNews.map(x => x && x.id));
            for (const v of extra || []) {
              if (v && v.id && !seenNewsIds.has(v.id)) {
                seenNewsIds.add(v.id);
                baseNews.push(v);
              }
            }
          }
          let tIdx = 0;
          let nIdx = 0;

          while (nIdx < baseNews.length || tIdx < trendVideos.length) {
            // 2 notícias de canais de jornalismo
            for (let k = 0; k < 2 && nIdx < baseNews.length; k++) {
              const nv = baseNews[nIdx++];
              if (nv && nv.id && !seen.has(nv.id)) {
                seen.add(nv.id);
                combined.push(nv);
              }
            }
            // 1 vídeo em alta do Google Trends
            if (tIdx < trendVideos.length) {
              const tv = trendVideos[tIdx++];
              if (tv && tv.id && !seen.has(tv.id)) {
                seen.add(tv.id);
                combined.push(tv);
              }
            }
          }

          freshVideos = combined.length > 0 ? combined : baseNews;
        } else if (!isCustomQuery && (searchMode === 'trending' || /^(em\s*alta|alta|tudo)$/i.test(String(qParam || '').trim()))) {
          // Busca em paralelo o Trending do YouTube e os tópicos mais buscados no Google Trends Brasil
          const googleTrendsPromise = (typeof ctx.fetchGoogleTrends === 'function')
            ? ctx.fetchGoogleTrends(countryCode, isForceRefresh).catch(() => [])
            : Promise.resolve([]);

          const ytTrendingPromise = Promise.race([
            ctx.fetchTrendingVideos({ useTor, country: countryCode, clientIp: effectiveClientIp }).catch(() => []),
            new Promise((resolve) => setTimeout(() => resolve([]), feedWait))
          ]);

          const [googleTrendsList, ytTrending] = await Promise.all([
            googleTrendsPromise,
            ytTrendingPromise
          ]);

          let trendVideos = [];
          if (Array.isArray(googleTrendsList) && googleTrendsList.length > 0) {
            // Busca vídeos mais recentes para os 10 tópicos líderes de pesquisa no Google Trends
            const topQueries = googleTrendsList.slice(0, 10);
            const trendResults = await Promise.all(
              topQueries.map((t) => searchFreshTrendVideos(t, 'trending'))
            );
            trendVideos = trendResults.flat();
          }

          const seen = new Set();
          const combined = [];
          for (const v of [...trendVideos, ...(ytTrending || [])]) {
            if (v && v.id && !seen.has(v.id)) {
              seen.add(v.id);
              combined.push(v);
            }
          }

          if (combined.length < 12) {
            const extra = await ctx.searchYoutubeVideos(dynamicQuery, hl, false, timeFilter, useTor, 'trending', countryCode, effectiveClientIp).catch(() => []);
            for (const v of extra || []) {
              if (v && v.id && !seen.has(v.id)) {
                seen.add(v.id);
                combined.push(v);
              }
            }
          }

          freshVideos = ctx.filterYoutubeModeResults(combined, 'trending');
        } else {
          freshVideos = await Promise.race([
            ctx.searchYoutubeVideos(dynamicQuery, hl, sortByRecent, timeFilter, useTor, searchMode, countryCode, effectiveClientIp).catch(() => []),
            new Promise((resolve) => setTimeout(() => resolve([]), feedWait))
          ]);
        }
      } catch (errFeed) {
        freshVideos = [];
      }

      freshVideos = countryRelevanceFilter(freshVideos, countryCode);

      // AUTO-EXPANSÃO / AUTO-PREENCHIMENTO:
      // Se a busca retornou menos de 6 vídeos, expandimos de forma ágil para garantir feed cheio e recente
      if (!freshVideos || freshVideos.length < 6) {
        const seenIds = new Set((freshVideos || []).map(v => v && v.id));
        const widerFilters = [];
        if (timeFilter === 'hour') widerFilters.push('day', 'week');
        else if (timeFilter === 'day') widerFilters.push('week', 'month');
        else if (timeFilter === 'week') widerFilters.push('month');

        for (const wider of widerFilters) {
          if (freshVideos.length >= 10) break;
          const extra = await Promise.race([
            ctx.searchYoutubeVideos(dynamicQuery, hl, wider !== 'none', wider, useTor, searchMode, countryCode, effectiveClientIp).catch(() => []),
            new Promise((resolve) => setTimeout(() => resolve([]), extraWait))
          ]);
          const filteredExtra = countryRelevanceFilter(extra || [], countryCode).filter((v) => !checkOldVideo(v, 30));
          for (const v of filteredExtra) {
            if (v && v.id && !seenIds.has(v.id)) {
              seenIds.add(v.id);
              freshVideos.push(v);
            }
          }
        }
      }

      // Se ainda tiver menos de 6 vídeos, busca usando consulta com nome do país explícito nas últimas semanas
      if (!freshVideos || freshVideos.length < 6) {
        const seenIds = new Set((freshVideos || []).map(v => v && v.id));
        const countryKeyword = countryCode === 'BR' ? 'brasil' : (countryCode === 'PT' ? 'portugal' : (COUNTRY_NAMES[countryCode] || countryCode));
        const fallbackQuery = `${qParam || 'noticias'} ${countryKeyword}`;
        const fallback = await Promise.race([
          ctx.searchYoutubeVideos(fallbackQuery, hl, true, 'week', useTor, searchMode, countryCode, effectiveClientIp).catch(() => []),
          new Promise((resolve) => setTimeout(() => resolve([]), extraWait))
        ]);
        const filteredFallback = countryRelevanceFilter(fallback || [], countryCode).filter((v) => !checkOldVideo(v, 30));
        for (const f of filteredFallback) {
          if (f && f.id && !seenIds.has(f.id)) {
            seenIds.add(f.id);
            freshVideos.push(f);
          }
        }
      }

      if (Array.isArray(freshVideos) && freshVideos.length > 0) {
        if (recentFeedFastCache.size > 150) {
          const firstK = recentFeedFastCache.keys().next().value;
          if (firstK) recentFeedFastCache.delete(firstK);
        }
        recentFeedFastCache.set(fastCacheKey, { ts: Date.now(), videos: freshVideos });
      }
      return freshVideos || [];
    };

    let videos = [];
    const cachedFeed = !isForceRefresh ? recentFeedFastCache.get(fastCacheKey) : null;
    if (cachedFeed && Array.isArray(cachedFeed.videos) && cachedFeed.videos.length > 0) {
      videos = cachedFeed.videos.slice();
      if (Date.now() - cachedFeed.ts > 90000) {
        fetchFreshFeedVideos().catch(() => {});
      }
    } else {
      const freshPromise = fetchFreshFeedVideos();
      const hasStale = staleFeedBeforeRefresh && Array.isArray(staleFeedBeforeRefresh.videos) && staleFeedBeforeRefresh.videos.length > 0;
      if (hasStale) {
        // Atualização forçada: espera no máximo ~7s; se passar disso, devolve o feed anterior embaralhado
        const raced = await Promise.race([
          freshPromise.catch(() => []),
          new Promise((resolve) => setTimeout(() => resolve(null), 7000))
        ]);
        if (Array.isArray(raced) && raced.length > 0) {
          videos = raced;
        } else {
          videos = staleFeedBeforeRefresh.videos.slice().sort(() => Math.random() - 0.5);
          freshPromise.catch(() => {});
        }
      } else {
        videos = await freshPromise;
      }
    }

    // Filtra conteúdos descurtidos pelo dispositivo e pontua afinidade com curtidas
    videos = filterAndRankVideosForDevice(videos || [], profile);
    const likedRelatedVideos = await likedRecommendationsPromise;

    let countryGoogleTrends = (typeof ctx.getCachedGoogleTrends === 'function') ? ctx.getCachedGoogleTrends(countryCode) : [];
    if ((!Array.isArray(countryGoogleTrends) || countryGoogleTrends.length === 0) && typeof ctx.fetchGoogleTrends === 'function') {
      countryGoogleTrends = await Promise.race([
        ctx.fetchGoogleTrends(countryCode, false).catch(() => []),
        new Promise((resolve) => setTimeout(() => resolve([]), 2200))
      ]);
    }

    const headingQuery = searchMode === 'trending'
      ? (countryCode === 'BR' ? 'em alta' : 'trending')
      : (searchMode === 'live'
        ? (countryCode === 'BR' ? 'ao vivo' : 'live')
        : (searchMode === 'podcast' ? 'podcast' : (qParam || 'noticias')));

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(JSON.stringify({
      success: true,
      countryCode,
      countryName: COUNTRY_NAMES[countryCode] || countryCode,
      countryFlag: COUNTRY_FLAGS[countryCode] || '🌍',
      clientIp: effectiveClientIp,
      query: headingQuery,
      likedCount: (profile && Array.isArray(profile.likes)) ? profile.likes.length : 0,
      likedRelatedVideos: (likedRelatedVideos || []).slice(0, 10),
      googleTrends: (countryGoogleTrends || []).slice(0, 10),
      videos: (videos || []).slice(0, 30)
    }));
    return true;
  }

  return false;
}

module.exports = {
  handle,
  COUNTRY_NAMES,
  COUNTRY_FLAGS
};
