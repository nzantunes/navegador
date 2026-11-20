const http = require('http');

const COUNTRY_MAP = {
  brasil: 'BR', brazil: 'BR', br: 'BR',
  eua: 'US', usa: 'US', 'estados unidos': 'US', america: 'US',
  reino: 'GB', uk: 'GB', inglaterra: 'GB', londres: 'GB', london: 'GB',
  japao: 'JP', japan: 'JP', toquio: 'JP', tokyo: 'JP',
  alemanha: 'DE', germany: 'DE', berlim: 'DE', berlin: 'DE',
  franca: 'FR', france: 'FR', paris: 'FR',
  italia: 'IT', italy: 'IT', roma: 'IT', rome: 'IT',
  espanha: 'ES', spain: 'ES', madrid: 'ES',
  portugal: 'PT', lisboa: 'PT',
  russia: 'RU', moscou: 'RU', moscow: 'RU',
  canada: 'CA', argentina: 'AR', mexico: 'MX', chile: 'CL', colombia: 'CO',
  coreia: 'KR', korea: 'KR', india: 'IN', china: 'CN', taiwan: 'TW',
  australia: 'AU', holanda: 'NL', suica: 'CH', austria: 'AT', polonia: 'PL',
  turquia: 'TR', ucrania: 'UA', suecia: 'SE', noruega: 'NO',
  romenia: 'RO', romania: 'RO', tchequia: 'CZ', 'republica tcheca': 'CZ',
  'sao paulo': 'BR', 'rio de janeiro': 'BR', curitiba: 'BR', brasilia: 'BR',
  'belo horizonte': 'BR', fortalez: 'BR', fortaleza: 'BR', salvador: 'BR',
  recife: 'BR', manaus: 'BR', 'porto alegre': 'BR', florianopolis: 'BR'
};

const CITY_ONLY_MAP = {
  'sao paulo': 'Sao_Paulo',
  'rio de janeiro': 'Rio_De_Janeiro',
  curitiba: 'Curitiba',
  brasilia: 'Brasilia',
  'belo horizonte': 'Belo_Horizonte',
  fortaleza: 'Fortaleza',
  salvador: 'Salvador',
  recife: 'Recife',
  manaus: 'Manaus',
  'porto alegre': 'Porto_Alegre',
  florianopolis: 'Florianopolis',
  toquio: 'Tokyo',
  tokyo: 'Tokyo',
  londres: 'London',
  london: 'London',
  berlim: 'Berlin',
  berlin: 'Berlin',
  paris: 'Paris',
  roma: 'Rome',
  rome: 'Rome',
  madrid: 'Madrid',
  lisboa: 'Lisbon',
  moscou: 'Moscow',
  moscow: 'Moscow'
};

// Mapeamento estrito para as tags oficiais suportadas por insecam.org (/en/jsontags/)
const TAG_MAP = {
  quarto: 'House', quartos: 'House', dormitorio: 'House', bedroom: 'House', bedrooms: 'House',
  suite: 'Hotel', cama: 'House', sala: 'House', apartamento: 'House', apartment: 'House',
  casa: 'House', house: 'House', home: 'House', residencia: 'House', moradia: 'House', quintal: 'House', yard: 'House',
  cozinha: 'Kitchen', kitchen: 'Kitchen',
  animal: 'Animal', animais: 'Animal', cachorro: 'Animal', cao: 'Animal', caes: 'Animal',
  dog: 'Animal', dogs: 'Animal', gato: 'Animal', gatos: 'Animal', cat: 'Animal', cats: 'Animal', pet: 'Animal', pets: 'Animal',
  passaro: 'Bird', passaros: 'Bird', ave: 'Bird', aves: 'Bird', bird: 'Bird', birds: 'Bird',
  fazenda: 'Farm', sitio: 'Farm', chacara: 'Farm', roca: 'Farm', rural: 'Farm', farm: 'Farm', rancho: 'Farm',
  estacionamento: 'Parking', parking: 'Parking', garagem: 'Parking', garage: 'Parking', carros: 'Parking', carro: 'Parking',
  rua: 'Street', ruas: 'Street', street: 'Street', avenida: 'Street', calcada: 'Street',
  praia: 'Beach', praias: 'Beach', beach: 'Beach', mar: 'Beach', oceano: 'Beach', litoral: 'Beach', costa: 'Beach',
  surf: 'Surfing', surfing: 'Surfing', onda: 'Surfing', ondas: 'Surfing',
  transito: 'Traffic', trafego: 'Traffic', traffic: 'Traffic',
  rodovia: 'Road', estrada: 'Road', road: 'Road', autoestrada: 'Road', highway: 'Road',
  escritorio: 'Office', office: 'Office', empresa: 'Office',
  loja: 'Shop', lojas: 'Shop', shop: 'Shop', mercado: 'Shop', supermercado: 'Shop', comercio: 'Shop', store: 'Shop',
  shopping: 'Mall', mall: 'Mall', galeria: 'Mall',
  hotel: 'Hotel', pousada: 'Hotel', resort: 'Hotel', hostel: 'Hotel', motel: 'Hotel',
  piscina: 'Pool', pool: 'Pool',
  cidade: 'City', city: 'City', centro: 'City',
  praca: 'Square', square: 'Square',
  vila: 'Village', vilarejo: 'Village', aldeia: 'Village', village: 'Village',
  porto: 'Marina', marina: 'Marina', navio: 'Marina', barco: 'Marina', iate: 'Marina', port: 'Marina', harbor: 'Marina',
  ponte: 'Bridge', bridge: 'Bridge',
  restaurante: 'Restaurant', restaurant: 'Restaurant', lanchonete: 'Restaurant', pizzaria: 'Restaurant',
  bar: 'Bar', pub: 'Bar', boteco: 'Bar', cervejaria: 'Bar',
  barbearia: 'Barbershop', barber: 'Barbershop', salao: 'Barbershop',
  cafe: 'Cafe', cafeteria: 'Cafe', padaria: 'Cafe', coffee: 'Cafe',
  aeroporto: 'Airliner', airport: 'Airliner', aviao: 'Airliner', airliner: 'Airliner',
  predio: 'Architecture', edificio: 'Architecture', building: 'Architecture', arquitetura: 'Architecture', architecture: 'Architecture',
  construcao: 'Construction', obra: 'Construction', construction: 'Construction',
  jardim: 'Park', garden: 'Park', parque: 'Park', park: 'Park',
  floresta: 'Nature', forest: 'Nature', natureza: 'Nature', nature: 'Nature', mata: 'Nature',
  paisagem: 'Landscape', landscape: 'Landscape', vista: 'Landscape',
  igreja: 'Religion', church: 'Religion', templo: 'Religion', temple: 'Religion', religiao: 'Religion', religion: 'Religion', catedral: 'Religion',
  escola: 'Education', school: 'Education', universidade: 'Education', university: 'Education', faculdade: 'Education', educacao: 'Education', education: 'Education',
  hospital: 'Service', clinica: 'Service', servico: 'Service', service: 'Service', oficina: 'Service',
  rio: 'River', river: 'River', cachoeira: 'River',
  lago: 'Lake', lagoa: 'Lake', lake: 'Lake',
  montanha: 'Mountain', mountain: 'Mountain', serra: 'Mountain',
  computador: 'Computer', computer: 'Computer', pc: 'Computer',
  servidor: 'Server', server: 'Server', datacenter: 'Server',
  impressora: 'Printer', printer: 'Printer',
  industria: 'Industrial', fabrica: 'Industrial', industrial: 'Industrial', factory: 'Industrial',
  energia: 'Energy', energy: 'Energy', solar: 'Energy',
  armazem: 'Warehouse', deposito: 'Warehouse', galpao: 'Warehouse', warehouse: 'Warehouse',
  lavanderia: 'Laundry', laundry: 'Laundry',
  esporte: 'Sport', sport: 'Sport', estadio: 'Sport', quadra: 'Sport', academia: 'Sport', gym: 'Sport', futebol: 'Sport',
  tempo: 'Weather', clima: 'Weather', weather: 'Weather', chuva: 'Weather', neve: 'Weather',
  entretenimento: 'Entertainment', entertainment: 'Entertainment', festa: 'Entertainment', show: 'Entertainment', teatro: 'Entertainment',
  tv: 'Tv', televisao: 'Tv', estudio: 'Tv',
  ptz: 'Ptz',
  hq: 'Hq',
  interessante: 'Interesting', interesting: 'Interesting',
  propaganda: 'Advertisement', advertisement: 'Advertisement'
};

const TYPE_MAP = {
  axis: 'Axis',
  foscam: 'Foscam',
  dlink: 'DLink',
  sony: 'Sony',
  panasonic: 'Panasonic',
  bosch: 'Bosch',
  canon: 'Canon',
  mobotix: 'Mobotix',
  vivotek: 'Vivotek',
  webcamxp: 'WebcamXP',
  yawcam: 'Yawcam',
  tplink: 'TPLink',
  linksys: 'Linksys',
  toshiba: 'Toshiba',
  android: 'Android-IPWebcam',
  defeway: 'Defeway',
  megapixel: 'Megapixel',
  blueiris: 'BlueIris',
  motion: 'Motion',
  streamer: 'Streamer',
  wificam: 'WIFICam',
  hi3516: 'Hi3516'
};

const STOP_WORDS = new Set([
  'em', 'na', 'no', 'nas', 'nos', 'de', 'da', 'do', 'das', 'dos',
  'in', 'at', 'on', 'the', 'and', 'or', 'cam', 'camera', 'cameras',
  'ip', 'ipcam', 'webcam', 'webcams', 'ao', 'vivo', 'live'
]);

const METADATA_TTL_MS = 6 * 60 * 60 * 1000;
let dynamicMetadata = {
  fetchedAt: 0,
  countries: {},
  tags: {}
};

function normalizeText(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function fetchHttpText(targetUrl, timeoutMs = 2500, signal = null, agent = undefined) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve('');
    let settled = false;
    let req = null;
    const onAbort = () => {
      try { if (req) req.destroy(); } catch (e) {}
      done('');
    };
    const done = (val) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(val);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      req = http.get(targetUrl, {
        agent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/json'
        }
      }, (res) => {
        if (res.statusCode >= 400) {
          res.resume();
          return done('');
        }
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 350000) res.destroy();
        });
        res.on('end', () => done(body));
        res.on('close', () => done(body));
      });
      req.on('error', () => done(''));
      req.setTimeout(timeoutMs, () => {
        try { req.destroy(); } catch (e) {}
        done('');
      });
    } catch (e) {
      done('');
    }
  });
}

async function ensureDynamicMetadata(agent = undefined) {
  if (Date.now() - dynamicMetadata.fetchedAt < METADATA_TTL_MS && Object.keys(dynamicMetadata.tags).length > 0) {
    return dynamicMetadata;
  }
  try {
    const [countriesRaw, tagsRaw] = await Promise.all([
      fetchHttpText('http://www.insecam.org/en/jsoncountries/', 2000, null, agent),
      fetchHttpText('http://www.insecam.org/en/jsontags/', 2000, null, agent)
    ]);
    const countries = {};
    if (countriesRaw) {
      const parsed = JSON.parse(countriesRaw);
      const map = (parsed && parsed.countries) || {};
      for (const [code, info] of Object.entries(map)) {
        if (info && info.country) {
          countries[normalizeText(info.country)] = code;
        }
      }
    }
    const tags = {};
    if (tagsRaw) {
      const parsed = JSON.parse(tagsRaw);
      const map = (parsed && parsed.tags) || {};
      for (const tagName of Object.keys(map)) {
        tags[normalizeText(tagName)] = tagName;
      }
    }
    if (Object.keys(countries).length > 0 || Object.keys(tags).length > 0) {
      dynamicMetadata = {
        fetchedAt: Date.now(),
        countries: Object.keys(countries).length > 0 ? countries : dynamicMetadata.countries,
        tags: Object.keys(tags).length > 0 ? tags : dynamicMetadata.tags
      };
    }
  } catch (e) {}
  return dynamicMetadata;
}

/**
 * Monta o plano de busca para insecam.org separando categorias explícitas, buscas genéricas e termos livres.
 */
function buildInsecamSearchPlan(query, page = 0, extraMeta = null) {
  const q = String(query || '').trim();
  const pageNum = Math.max(0, parseInt(page, 10) || 0);
  const norm = normalizeText(q);
  const tokens = norm.split(/\s+/).filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  const isGenericCamQuery = /^(?:cam|camera|cameras|ipcam|ip\s*cam|webcam|webcams|live|ao\s*vivo|mundo|world|all|todas)$/i.test(norm);

  const dynCountries = (extraMeta && extraMeta.countries) || {};
  const dynTags = (extraMeta && extraMeta.tags) || {};

  const lookupCountry = (k) => COUNTRY_MAP[k] || dynCountries[k] || null;
  const lookupTag = (k) => TAG_MAP[k] || dynTags[k] || null;

  const matchedCities = [];
  const matchedTags = [];
  const matchedCountries = [];
  const matchedTypes = [];

  if (CITY_ONLY_MAP[norm]) matchedCities.push(CITY_ONLY_MAP[norm]);
  if (lookupTag(norm)) matchedTags.push(lookupTag(norm));
  if (lookupCountry(norm)) matchedCountries.push(lookupCountry(norm));
  if (TYPE_MAP[norm]) matchedTypes.push(TYPE_MAP[norm]);

  for (const tok of tokens) {
    if (CITY_ONLY_MAP[tok] && !matchedCities.includes(CITY_ONLY_MAP[tok])) matchedCities.push(CITY_ONLY_MAP[tok]);
    const t = lookupTag(tok);
    if (t && !matchedTags.includes(t)) matchedTags.push(t);
    const c = lookupCountry(tok);
    if (c && !matchedCountries.includes(c)) matchedCountries.push(c);
    if (TYPE_MAP[tok] && !matchedTypes.includes(TYPE_MAP[tok])) matchedTypes.push(TYPE_MAP[tok]);
  }

  if (/^(?:quarto|quartos|dormitorio|bedroom|bedrooms|suite)$/.test(norm) && !matchedTags.includes('Hotel')) {
    matchedTags.push('Hotel');
  }

  const urls = [];
  const startP = pageNum * 2 + 1;
  const hasExplicitCategory = matchedCities.length > 0 || matchedTags.length > 0 || matchedCountries.length > 0 || matchedTypes.length > 0;

  if (hasExplicitCategory) {
    for (const city of matchedCities.slice(0, 2)) {
      urls.push(`http://www.insecam.org/en/bycity/${city}/?page=${startP}`);
      urls.push(`http://www.insecam.org/en/bycity/${city}/?page=${startP + 1}`);
    }
    for (const tag of matchedTags.slice(0, 2)) {
      urls.push(`http://www.insecam.org/en/bytag/${tag}/?page=${startP}`);
      urls.push(`http://www.insecam.org/en/bytag/${tag}/?page=${startP + 1}`);
    }
    for (const cc of matchedCountries.slice(0, 2)) {
      const ccStart = pageNum === 0 ? 1 : pageNum * 2;
      urls.push(`http://www.insecam.org/en/bycountry/${cc}/?page=${ccStart}`);
      urls.push(`http://www.insecam.org/en/bycountry/${cc}/?page=${ccStart + 1}`);
    }
    for (const tp of matchedTypes.slice(0, 2)) {
      urls.push(`http://www.insecam.org/en/bytype/${tp}/?page=${startP}`);
      urls.push(`http://www.insecam.org/en/bytype/${tp}/?page=${startP + 1}`);
    }
  } else if (!isGenericCamQuery) {
    const citySlug = q.trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('_');
    if (citySlug && !/^\d/.test(citySlug)) {
      urls.push(`http://www.insecam.org/en/bycity/${encodeURIComponent(citySlug)}/?page=${startP}`);
      urls.push(`http://www.insecam.org/en/bytag/${encodeURIComponent(citySlug)}/?page=${startP}`);
      urls.push(`http://www.insecam.org/en/bytype/${encodeURIComponent(citySlug)}/?page=${startP}`);
    }
  } else {
    urls.push(`http://www.insecam.org/en/bynew/?page=${startP}`);
    urls.push(`http://www.insecam.org/en/bynew/?page=${startP + 1}`);
    urls.push(`http://www.insecam.org/en/byrating/?page=${startP}`);
    urls.push(`http://www.insecam.org/en/byrating/?page=${startP + 1}`);
  }

  return {
    norm,
    tokens,
    isGenericCamQuery,
    hasExplicitCategory,
    urls: Array.from(new Set(urls)).slice(0, 4)
  };
}

/**
 * Extrai cards de câmeras IP do HTML do insecam.org com filtro opcional por tokens.
 */
function parseInsecamCards(htmlPages, limit = 24, filterTokens = null) {
  const seenIps = new Set();
  const out = [];
  const cardRe = /<a[^>]*href="\/en\/view\/(\d+)\/"[^>]*title="([^"]*)"[^>]*>[\s\S]*?<img[^>]*src="(https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?[^"]*)"[^>]*>/gi;
  for (const html of htmlPages || []) {
    if (!html) continue;
    let m;
    while ((m = cardRe.exec(html)) !== null) {
      const camId = m[1];
      const rawTitle = String(m[2] || '')
        .replace(/&(?:amp;)+/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
      const streamUrl = String(m[3] || '').replace(/&(?:amp;)+/gi, '&').trim();
      if (!streamUrl) continue;
      let ipHost = '';
      try { ipHost = new URL(streamUrl).host; } catch (e) { continue; }
      if (!ipHost || seenIps.has(ipHost)) continue;
      if (filterTokens && filterTokens.length > 0) {
        const hay = normalizeText(`${rawTitle} ${ipHost} ${camId} ${streamUrl}`);
        if (!filterTokens.some((tok) => hay.includes(tok))) continue;
      }
      seenIps.add(ipHost);
      out.push({
        title: `📹 ${rawTitle || 'Câmera IP Pública'} (${ipHost})`,
        url: streamUrl,
        image: streamUrl,
        snippet: `IP acessível na internet: http://${ipHost} • Stream direto (${camId})`,
        source: 'ip-cam',
        host: ipHost
      });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

async function searchPublicIpCameras(query, limit = 24, page = 0, cache = null, agent = undefined) {
  const q = String(query || '').trim();
  if (!q) return [];
  const pageNum = Math.max(0, parseInt(page, 10) || 0);
  const norm = normalizeText(q);
  const cacheKey = `${norm}:${limit}:${pageNum}`;
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.t < 300000)) return cached.list;
  }

  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const sig = ac ? ac.signal : null;
  const abortTimer = ac ? setTimeout(() => { try { ac.abort(); } catch (e) {} }, 6000) : null;
  try {
    const meta = await ensureDynamicMetadata(agent);
    const plan = buildInsecamSearchPlan(q, pageNum, meta);
    const htmlPages = plan.urls.length > 0 ? await Promise.all(plan.urls.map((u) => fetchHttpText(u, 2500, sig, agent))) : [];
    let list = parseInsecamCards(htmlPages, limit);

    if (list.length === 0 && !plan.isGenericCamQuery && plan.tokens.length > 0 && !(sig && sig.aborted)) {
      const scanStart = pageNum * 3 + 1;
      const scanUrls = [
        `http://www.insecam.org/en/bynew/?page=${scanStart}`,
        `http://www.insecam.org/en/bynew/?page=${scanStart + 1}`,
        `http://www.insecam.org/en/byrating/?page=${scanStart}`,
        `http://www.insecam.org/en/byrating/?page=${scanStart + 1}`
      ];
      const scanPages = await Promise.all(scanUrls.map((u) => fetchHttpText(u, 2500, sig, agent)));
      list = parseInsecamCards(scanPages, limit, plan.tokens);
    }

    if (cache && list.length > 0) {
      cache.set(cacheKey, { t: Date.now(), list });
    }
    return list;
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
    if (ac) { try { ac.abort(); } catch (e) {} }
  }
}

module.exports = {
  buildInsecamSearchPlan,
  parseInsecamCards,
  searchPublicIpCameras
};
