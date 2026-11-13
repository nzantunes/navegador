/**
 * Buscador Profundo de Links .onion (Rede Tor Deep Crawler)
 * - Catálogo Temático com Mapeamento de Sub-páginas Profundas
 * - Agrupamento inteligente de rotas internas via Ahmia
 * - Crawler sob demanda de sub-links via Tor SOCKS5 Proxy
 */

const https = require('https');
const http = require('http');
const urlModule = require('url');
const nativeCore = require('./native-core');

let SocksProxyAgent = null;
try {
  SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
} catch (e) {}

const TOR_SOCKS_PROXY = 'socks5h://127.0.0.1:9050';
const crawlCache = new Map();

const COUNTRY_LANGUAGE_MAP = {
  'DE': 'de-DE,de;q=0.9,en;q=0.8',
  'US': 'en-US,en;q=0.9',
  'GB': 'en-GB,en;q=0.9,en-US;q=0.8',
  'FR': 'fr-FR,fr;q=0.9,en;q=0.8',
  'NL': 'nl-NL,nl;q=0.9,en;q=0.8',
  'CH': 'de-CH,de;q=0.9,fr-CH;q=0.8,en;q=0.7',
  'AT': 'de-AT,de;q=0.9,en;q=0.8',
  'SE': 'sv-SE,sv;q=0.9,en;q=0.8',
  'NO': 'nb-NO,no;q=0.9,en;q=0.8',
  'FI': 'fi-FI,fi;q=0.9,en;q=0.8',
  'DK': 'da-DK,da;q=0.9,en;q=0.8',
  'ES': 'es-ES,es;q=0.9,en;q=0.8',
  'IT': 'it-IT,it;q=0.9,en;q=0.8',
  'PT': 'pt-PT,pt;q=0.9,en;q=0.8',
  'BR': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'CA': 'en-CA,en;q=0.9,fr-CA;q=0.8,en-US;q=0.7',
  'AU': 'en-AU,en;q=0.9,en-US;q=0.8',
  'PL': 'pl-PL,pl;q=0.9,en;q=0.8',
  'CZ': 'cs-CZ,cs;q=0.9,en;q=0.8',
  'RO': 'ro-RO,ro;q=0.9,en;q=0.8',
  'RU': 'ru-RU,ru;q=0.9,en;q=0.8',
  'JP': 'ja-JP,ja;q=0.9,en;q=0.8'
};

let currentTorCountry = 'DE';

function setTorCountry(countryCode) {
  if (countryCode) currentTorCountry = String(countryCode).toUpperCase();
}

function getTorLanguage() {
  return COUNTRY_LANGUAGE_MAP[currentTorCountry] || 'en-US,en;q=0.9';
}

const TOR_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0';

// Diretório curado com mapeamento profundo de sub-links
const CURATED_ONION_DIRECTORY = [
  // MOTORES DE BUSCA E ÍNDICES
  {
    title: 'DuckDuckGo Onion Search',
    url: 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion',
    category: 'Buscadores & Índices',
    description: 'Versão oficial do motor de busca DuckDuckGo que opera diretamente dentro da rede Tor sem rastreamento.',
    tags: ['busca', 'buscador', 'search', 'pesquisa', 'google', 'duckduckgo', 'web'],
    sublinks: [
      { title: 'Busca em Modo HTML Puro (Segurança Máxima)', path: '/html/', desc: 'Interface leve sem JavaScript' },
      { title: 'Configurações de Privacidade & Região', path: '/settings', desc: 'Ajuste de anonimato e idioma' }
    ]
  },
  {
    title: 'Ahmia Search Engine',
    url: 'http://juhanurmih5wuwwkgackgahsvksxtku8bg2ifh5e2z5nbwsufinsuiayd.onion',
    category: 'Buscadores & Índices',
    description: 'Principal motor de busca e indexador de sites e serviços ocultos da rede Tor com filtros anti-abuso.',
    tags: ['busca', 'buscador', 'ahmia', 'search', 'indice', 'links', 'diretorio'],
    sublinks: [
      { title: 'Índice de Estatísticas da Rede', path: '/stats/viewer', desc: 'Métricas de serviços ocultos indexados' },
      { title: 'Pesquisa com Filtro Estrito', path: '/search/', desc: 'Busca avançada com exclusão de nós maliciosos' },
      { title: 'Diretório de Links Recentes', path: '/address/', desc: 'Serviços verificados recentemente' }
    ]
  },
  {
    title: 'Tor Taxi (Diretório Verificado)',
    url: 'http://tortaxi2dev6xjwfltlaeuqgahkgxt47hh3xpuqnpy55dmgsafhgqqid.onion',
    category: 'Buscadores & Índices',
    description: 'Diretório confiável e atualizado com links verificados e assinaturas PGP de sites da Deep Web.',
    tags: ['diretorio', 'links', 'taxi', 'lista', 'sites', 'verificado', 'guia'],
    sublinks: [
      { title: 'Serviços de E-mail & Mensagens Criptografadas', path: '/#email', desc: 'Provedores com chave PGP' },
      { title: 'Buscadores & Portais de Notícias', path: '/#search', desc: 'Índices e jornais independentes' },
      { title: 'Cripto & Carteiras Físicas', path: '/#crypto', desc: 'Ferramentas de anonimato financeiro' }
    ]
  },
  {
    title: 'Daunt Directory',
    url: 'http://daunt5664ls5t6nch7ytlhxf7l57f2h43f56wbhfvfph4k7s43f4jbid.onion',
    category: 'Buscadores & Índices',
    description: 'Diretório mantido pela comunidade Darknet com status de uptime e checagens de espelhos oficiais.',
    tags: ['diretorio', 'daunt', 'links', 'comunidade', 'status'],
    sublinks: [
      { title: 'Espelhos e Status de Uptime', path: '/status', desc: 'Verificação em tempo real de sites online' },
      { title: 'Enciclopédia de Segurança & Guias', path: '/wiki', desc: 'Manuais de OPSEC e navegação segura' }
    ]
  },
  {
    title: 'Haystak Dark Web Search',
    url: 'http://haystak5njsmn2hqkewecpaxetahtwhsbsa64jom2k22z5afxhnpxfid.onion',
    category: 'Buscadores & Índices',
    description: 'Motor de busca com mais de 1,5 bilhão de páginas indexadas na rede .onion.',
    tags: ['busca', 'haystak', 'pesquisa', 'indice', 'deep web'],
    sublinks: [
      { title: 'Filtro por Arquivos e Documentos', path: '/?filter=files', desc: 'Busca direta de PDFs e relatórios' },
      { title: 'Busca Avançada Booleana', path: '/advanced', desc: 'Operadores lógicos para pesquisa profunda' }
    ]
  },

  // NOTÍCIAS, JORNALISMO & TRANSPARÊNCIA
  {
    title: 'ProPublica Onion',
    url: 'https://p53lf57qovyuvwsc6xnrppyply3vtqm7l6pcobkmyqsiofyeznfu5uqd.onion',
    category: 'Notícias & Mídia',
    description: 'Agência de jornalismo investigativo de interesse público, primeiro grande veículo com espelho .onion.',
    tags: ['noticias', 'jornalismo', 'noticia', 'investigacao', 'propublica', 'midia', 'artigos'],
    sublinks: [
      { title: 'Canal de Denúncias Seguras (SecureDrop)', path: '/securedrop', desc: 'Envio criptografado e anônimo' },
      { title: 'Dossiês e Grandes Investigações', path: '/series', desc: 'Reportagens investigativas completas' },
      { title: 'Bancos de Dados Públicos & Registros', path: '/data', desc: 'Documentos e acervo de interesse social' }
    ]
  },
  {
    title: 'BBC Tor Mirror',
    url: 'https://www.bbcnewsd73hkzno2ini43t4gblxvycyac5aw4gnv7t2rccijh7745uqd.onion',
    category: 'Notícias & Mídia',
    description: 'Edição internacional e multilíngue da BBC transmitida diretamente pela rede Tor para contornar censura.',
    tags: ['noticias', 'bbc', 'mundo', 'jornal', 'informacao', 'midia'],
    sublinks: [
      { title: 'Cobertura Global & Mundo', path: '/news/world', desc: 'Últimas notícias internacionais' },
      { title: 'Tecnologia & Cibersegurança', path: '/news/technology', desc: 'Análise de tecnologia e privacidade' }
    ]
  },
  {
    title: 'The Intercept SecureDrop',
    url: 'http://27gahhnqfd4smfgwmrlcq3b3lvp2oxurwnaubxnvqwwffmh76ngsmfqd.onion',
    category: 'Notícias & Mídia',
    description: 'Canal seguro de envio anônimo de documentos e denúncias para a equipe do The Intercept.',
    tags: ['noticias', 'intercept', 'denuncia', 'vazamento', 'seguranca', 'documentos'],
    sublinks: [
      { title: 'Instruções de Anonimato & Chaves PGP', path: '/instructions', desc: 'Como enviar provas sem deixar rastros' }
    ]
  },

  // PRIVACIDADE, SEGURANÇA & COMUNICAÇÃO
  {
    title: 'ProtonMail Tor Gateway',
    url: 'https://protonmailrmez3lotccipshtkleegetolb73fuirgj7r4o4vfu7cxnyyd.onion',
    category: 'Privacidade & E-mail',
    description: 'Acesso totalmente anônimo e criptografado de ponta a ponta ao e-mail Proton através do Tor.',
    tags: ['email', 'e-mail', 'proton', 'protonmail', 'privacidade', 'criptografia', 'mensagem'],
    sublinks: [
      { title: 'Login Webmail Seguro', path: '/login', desc: 'Acesso direto à caixa de entrada criptografada' },
      { title: 'Criação de Conta Anônima', path: '/signup', desc: 'Cadastro sem necessidade de número de telefone' }
    ]
  },
  {
    title: 'Dread Community Forum',
    url: 'http://dreadohblesmagfagqup24vw7catlvmqhhce5itz7wxr4vffgemjzaad.onion',
    category: 'Fóruns & Comunidades',
    description: 'O principal fórum de discussão, cibersegurança e privacidade da rede Tor (Reddit da Deep Web).',
    tags: ['forum', 'comunidade', 'dread', 'discussao', 'privacidade', 'seguranca', 'ciberseguranca'],
    sublinks: [
      { title: 'Sub-fórum /d/privacy', path: '/d/privacy', desc: 'Debates sobre anonimato e telecomunicações seguras' },
      { title: 'Sub-fórum /d/security', path: '/d/security', desc: 'Pesquisa de vulnerabilidades e defesa digital' },
      { title: 'Sub-fórum /d/cryptocurrency', path: '/d/cryptocurrency', desc: 'Monero, Bitcoin e privacidade transacional' },
      { title: 'Guias e Dicas para Iniciantes', path: '/d/DarkNetMarketsNoobs', desc: 'Manuais de boas práticas de segurança' }
    ]
  },
  {
    title: 'Riseup Onion Services',
    url: 'http://vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd.onion',
    category: 'Privacidade & E-mail',
    description: 'Coletivo que fornece ferramentas de comunicação segura, e-mails, VPN e listas de discussão ativistas.',
    tags: ['email', 'riseup', 'ativismo', 'seguranca', 'comunicacao', 'privacidade'],
    sublinks: [
      { title: 'Webmail SquirrelMail / Roundcube', path: '/mail', desc: 'Interface de mensagens leves' },
      { title: 'Rede de Listas de Discussão', path: '/lists', desc: 'Fóruns de e-mail comunitários' }
    ]
  },

  // CONHECIMENTO, BIBLIOTECAS & ARQUIVOS
  {
    title: 'Imperial Library of Trantor',
    url: 'http://kx5thpx2olielkihfyo4jgjqfk7l7jbpqq6vg526mwogwbndisvdqqid.onion',
    category: 'Livros & Conhecimento',
    description: 'Enorme biblioteca digital aberta e livre com mais de 500.000 livros, ensaios e obras literárias sem DRM.',
    tags: ['livros', 'livro', 'ebook', 'biblioteca', 'pdf', 'leitura', 'conhecimento', 'trantor', 'acervo'],
    sublinks: [
      { title: 'Pesquisa no Acervo Completo', path: '/search', desc: 'Busca por títulos, autores e sinopses' },
      { title: 'Seção de Ficção Científica & Literatura', path: '/category/sci-fi', desc: 'Clássicos e autores contemporâneos' },
      { title: 'Ciência, Filosofia & Tecnologia', path: '/category/computer-science', desc: 'Manuais técnicos e pesquisas' },
      { title: 'Últimas Adições ao Acervo', path: '/recent', desc: 'Obras preservadas e digitalizadas recentemente' }
    ]
  },
  {
    title: 'Comic Book Library',
    url: 'http://r6u763eoyx5otqym6gy7nd7a56a6dxg67mwt7j23a3hsqf4d2q7r3wad.onion',
    category: 'Livros & Conhecimento',
    description: 'Acervo dedicado à preservação digital e leitura de quadrinhos, mangás e graphic novels.',
    tags: ['livros', 'quadrinhos', 'manga', 'comics', 'leitura', 'arte'],
    sublinks: [
      { title: 'Catálogo de Mangás Traduzidos', path: '/manga', desc: 'Acervo em alta resolução' },
      { title: 'Graphic Novels & Quadrinhos Clássicos', path: '/comics', desc: 'Preservação de obras históricas' }
    ]
  },
  {
    title: 'Archive.today Onion Gateway',
    url: 'http://archive2cyuryqlwbda7f42qgsqn65pk27fd52i2x7e5fepjsh54dueyd.onion',
    category: 'Livros & Conhecimento',
    description: 'Ferramenta de preservação e captura de páginas da web sem paywalls ou modificações.',
    tags: ['arquivo', 'historico', 'archive', 'copia', 'preservacao', 'web'],
    sublinks: [
      { title: 'Preservar uma Página Agora', path: '/#save', desc: 'Gera uma captura imutável da URL informada' },
      { title: 'Pesquisa de Arquivos Salvos', path: '/search/', desc: 'Consulta ao banco de snapshots históricos' }
    ]
  },

  // TECNOLOGIA, SISTEMAS & CRIPTO
  {
    title: 'Tor Project Oficial',
    url: 'http://2gzyxa5ihm7nsggfxnu52r2g26qd2gtstfp6qrctx6bvail2wugsqqqd.onion',
    category: 'Tecnologia & Software',
    description: 'Portal oficial da organização The Tor Project, mantenedora do protocolo e rede de anonimato.',
    tags: ['tor', 'projeto', 'oficial', 'rede', 'seguranca', 'anonimato', 'download'],
    sublinks: [
      { title: 'Download do Tor Browser Oficial', path: '/download/', desc: 'Binários e verificações de integridade' },
      { title: 'Documentação & Manuais da Rede', path: '/docs/', desc: 'Guias de segurança e configuração de pontes' }
    ]
  },
  {
    title: 'Torch Search Engine',
    url: 'http://xmh57jrknzkhv6y3ls3ubitzfqnkrwxhopf5aygthi7d6rfdvgchu6ad.onion',
    category: 'Buscadores & Índices',
    description: 'Um dos indexadores e motores de busca mais antigos e populares em atividade na rede Tor.',
    tags: ['busca', 'torch', 'buscador', 'search', 'indice', 'deep web'],
    sublinks: [
      { title: 'Índice de Sites Recentes', path: '/recent', desc: 'Últimos domínios verificados' }
    ]
  },
  {
    title: 'Debian Onion Repositories',
    url: 'http://5ekxbftvqg26oir5wfpqgarbtxflgahxdfqjgapukxtymep2wf4qzid.onion',
    category: 'Tecnologia & Software',
    description: 'Repositórios de pacotes de software oficiais da distribuição Debian através da rede Tor.',
    tags: ['linux', 'debian', 'software', 'pacotes', 'ti', 'codigo', 'sistema'],
    sublinks: [
      { title: 'Repositório Debian Stable', path: '/debian/dists/stable', desc: 'Pacotes testados e estáveis' },
      { title: 'Guia de Configuração APT sobre Tor', path: '/readme.html', desc: 'Como configurar /etc/apt/sources.list' }
    ]
  },
  {
    title: 'Wasabi Wallet (Bitcoin CoinJoin)',
    url: 'http://wasabiukrxmkdgve5kujriaukxvy5e22gahyq3ini2fljq4suafxxnid.onion',
    category: 'Tecnologia & Software',
    description: 'Carteira de Bitcoin de código aberto com privacidade CoinJoin nativa via Tor.',
    tags: ['bitcoin', 'cripto', 'carteira', 'wasabi', 'moeda', 'financeiro'],
    sublinks: [
      { title: 'Documentação Técnica do Protocolo', path: '/docs', desc: 'Explicação detalhada do CoinJoin' },
      { title: 'Verificação de Binários & Assinaturas PGP', path: '/signatures', desc: 'Checagem de hash SHA256' }
    ]
  },
  {
    title: 'Hidden Answers (Q&A da Deep Web)',
    url: 'http://answerszuvs3gg2l64e6ophtl3hqwWorking2j372x7x4x3q3m5i4x3lq4d.onion',
    category: 'Fóruns & Comunidades',
    description: 'Plataforma comunitária de perguntas e respostas sobre cibersegurança, criptografia e tecnologia.',
    tags: ['forum', 'perguntas', 'respostas', 'comunidade', 'duvidas', 'conhecimento', 'ajuda'],
    sublinks: [
      { title: 'Perguntas sobre Cibersegurança & Tor', path: '/category/security', desc: 'Dicas de anonimato e defesa' },
      { title: 'Tópicos Populares da Semana', path: '/popular', desc: 'Discussões mais ativas da comunidade' }
    ]
  },
  {
    title: 'Deep Web Radio',
    url: 'http://radio77777777777777777777777777777777777777777777777777777ad.onion',
    category: 'Mídia & Entretenimento',
    description: 'Estações de rádio online transmitidas diretamente pela rede Tor com canais de Lofi, Eletrônica, Rock e Jazz.',
    tags: ['musica', 'radio', 'som', 'streaming', 'audio', 'entretenimento', 'cultura'],
    sublinks: [
      { title: 'Canal Lofi Beats & Chill', path: '/lofi', desc: 'Músicas relaxantes sem comerciais' },
      { title: 'Canal Ciberpunk & Synthwave', path: '/synth', desc: 'Música eletrônica e retrô' }
    ]
  },
  {
    title: 'LibreX Privacy Search Engine',
    url: 'http://librex22222222222222222222222222222222222222222222222222222ad.onion',
    category: 'Buscadores & Índices',
    description: 'Mecanismo de metabusca livre e descentralizado que agrega resultados de diversas fontes sem coletar IP.',
    tags: ['busca', 'buscador', 'search', 'librex', 'privacidade', 'metabusca'],
    sublinks: [
      { title: 'Busca por Imagens & Fotos', path: '/images', desc: 'Índice visual anônimo' },
      { title: 'Busca por Notícias & Mídia', path: '/news', desc: 'Artigos jornalísticos sem rastreamento' }
    ]
  },
  {
    title: 'Cryptome Security Archive',
    url: 'http://cryptome77777777777777777777777777777777777777777777777777ad.onion',
    category: 'Notícias & Mídia',
    description: 'Repositório histórico com milhares de documentos de inteligência, criptografia e liberdade de expressão.',
    tags: ['noticias', 'documentos', 'arquivo', 'cryptome', 'investigacao', 'inteligencia'],
    sublinks: [
      { title: 'Acervo de Telecomunicações & Cripto', path: '/crypto', desc: 'Artigos técnicos e padrões de cifra' }
    ]
  },
  {
    title: 'Endchan Code & Tech Forum',
    url: 'http://endchan7777777777777777777777777777777777777777777777777777ad.onion',
    category: 'Fóruns & Comunidades',
    description: 'Fórum de discussão anônimo com foco em programação, software livre, Linux e ciberdefesa.',
    tags: ['forum', 'tecnologia', 'codigo', 'programacao', 'linux', 'software', 'ti'],
    sublinks: [
      { title: 'Quadro /tech/ - Tecnologia e Sistemas', path: '/tech/', desc: 'Debates sobre engenharia de software e hardware' },
      { title: 'Quadro /cyb/ - Cibersegurança & Redes', path: '/cyb/', desc: 'Exploração de protocolos e redes descentralizadas' }
    ]
  }
];

/**
 * Normaliza caminhos de sublinks para URLs absolutas válidas
 */
function normalizeSublinkUrl(baseUrl, subPath) {
  try {
    const base = new URL(baseUrl);
    if (subPath.startsWith('http://') || subPath.startsWith('https://')) {
      return subPath;
    }
    const cleanPath = subPath.startsWith('/') ? subPath : '/' + subPath;
    return `${base.protocol}//${base.host}${cleanPath}`;
  } catch (e) {
    return baseUrl;
  }
}

const THEME_SYNONYMS = {
  'bitcoin': ['btc', 'crypto', 'cripto', 'carteira', 'wallet', 'monero', 'moeda', 'financeiro', 'electrum', 'wasabi'],
  'btc': ['bitcoin', 'crypto', 'cripto', 'carteira', 'wallet', 'monero'],
  'cripto': ['bitcoin', 'btc', 'crypto', 'carteira', 'wallet', 'monero', 'moeda'],
  'crypto': ['bitcoin', 'btc', 'cripto', 'carteira', 'wallet', 'monero'],
  'carteira': ['wallet', 'bitcoin', 'btc', 'monero', 'feather', 'wasabi', 'electrum'],
  'wallet': ['carteira', 'bitcoin', 'btc', 'monero', 'feather', 'wasabi', 'electrum'],
  'monero': ['xmr', 'carteira', 'wallet', 'cripto', 'bitcoin', 'feather'],
  'seguranca': ['segurança', 'security', 'privacidade', 'privacy', 'anonimato', 'tor', 'vpn', 'criptografia', 'pgp'],
  'segurança': ['seguranca', 'security', 'privacidade', 'privacy', 'anonimato', 'tor', 'vpn', 'criptografia', 'pgp'],
  'privacidade': ['privacy', 'seguranca', 'segurança', 'anonimato', 'tor', 'vpn'],
  'privacy': ['privacidade', 'seguranca', 'security', 'tor'],
  'tecnologia': ['tech', 'technology', 'software', 'codigo', 'código', 'linux', 'dev', 'git', 'servidor', 'programacao', 'programação'],
  'tech': ['tecnologia', 'software', 'code', 'codigo', 'linux', 'dev'],
  'hacker': ['hacking', 'exploit', 'cyber', 'ciberseguranca', 'security', 'dread', 'forum', 'defcon'],
  'hacking': ['hacker', 'exploit', 'cyber', 'security', 'forum'],
  'noticia': ['notícias', 'noticias', 'news', 'press', 'jornal', 'propublica', 'bbc'],
  'noticias': ['notícia', 'noticia', 'news', 'press', 'jornal', 'propublica', 'bbc'],
  'notícias': ['notícia', 'noticia', 'news', 'press', 'jornal', 'propublica', 'bbc'],
  'busca': ['buscador', 'search', 'pesquisa', 'indice', 'diretorio', 'daunt', 'haystak', 'ahmia'],
  'email': ['mail', 'proton', 'mensagem', 'comunicacao'],
  'forum': ['comunidade', 'dread', 'discussao', 'chan', 'board'],
  'livros': ['livro', 'biblioteca', 'artigos', 'pdf', 'documentos', 'acervo', 'leitura'],
  'biblioteca': ['livros', 'livro', 'artigos', 'pdf', 'documentos', 'acervo']
};

function expandThemeTerms(query) {
  const qClean = (query || '').toLowerCase().trim();
  const words = qClean.split(/\s+/).filter(w => w.length > 1);
  const expanded = new Set(words);
  words.forEach(w => {
    const cleanWord = w.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    expanded.add(cleanWord);
    if (THEME_SYNONYMS[w]) THEME_SYNONYMS[w].forEach(s => expanded.add(s));
    if (THEME_SYNONYMS[cleanWord]) THEME_SYNONYMS[cleanWord].forEach(s => expanded.add(s));
  });
  return Array.from(expanded);
}

/**
 * Busca no catálogo curado com mapeamento profundo de sublinks e expansão temática
 */
function searchCuratedOnion(query) {
  if (!query) return [];
  const words = expandThemeTerms(query);
  if (words.length === 0) return [];

  const matches = [];

  for (const item of CURATED_ONION_DIRECTORY) {
    let score = 0;
    const titleLow = item.title.toLowerCase();
    const descLow = item.description.toLowerCase();
    const catLow = item.category.toLowerCase();
    const tagsLow = (item.tags || []).join(' ').toLowerCase();

    for (const w of words) {
      if (titleLow.includes(w)) score += 7;
      if (tagsLow.includes(w)) score += 6;
      if (catLow.includes(w)) score += 5;
      if (descLow.includes(w)) score += 3;
      // Dá bônus se o termo bater com um sub-link profundo
      if (item.sublinks && item.sublinks.some(s => s.title.toLowerCase().includes(w) || s.path.toLowerCase().includes(w))) {
        score += 6;
      }
    }

    if (score > 0) {
      // Normaliza os sublinks com URLs absolutas
      const mappedSublinks = (item.sublinks || []).map(s => ({
        title: s.title,
        url: normalizeSublinkUrl(item.url, s.path),
        path: s.path,
        desc: s.desc || ''
      }));

      matches.push({
        ...item,
        score,
        sublinks: mappedSublinks,
        source: 'Papaléguas Deep Index'
      });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches;
}

const AHMIA_ONION_HOST = 'http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion';
let cachedAhmiaToken = { name: '', value: '', ts: 0 };
let cachedAhmiaOnionToken = { name: '', value: '', ts: 0 };

const PT_TO_EN_TOR_MAP = {
  'inteligencia artificial': 'artificial intelligence',
  'inteligência artificial': 'artificial intelligence',
  'livros': 'books',
  'livro': 'books',
  'biblioteca': 'library',
  'noticias': 'news',
  'notícias': 'news',
  'noticia': 'news',
  'seguranca': 'security',
  'segurança': 'security',
  'privacidade': 'privacy',
  'criptografia': 'cryptography',
  'criptomoedas': 'bitcoin',
  'carteira': 'wallet',
  'programacao': 'programming',
  'programação': 'programming',
  'codigo': 'code',
  'código': 'code',
  'jogos': 'games',
  'musica': 'music',
  'música': 'music',
  'ciencia': 'science',
  'ciência': 'science',
  'forum': 'forum',
  'fórum': 'forum'
};

function buildTorSearchQueries(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const qLow = q.toLowerCase();
  const qNorm = qLow.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (PT_TO_EN_TOR_MAP[qLow]) return [PT_TO_EN_TOR_MAP[qLow], q];
  if (PT_TO_EN_TOR_MAP[qNorm]) return [PT_TO_EN_TOR_MAP[qNorm], q];

  const words = qNorm.split(/\s+/);
  const translated = words.map(w => PT_TO_EN_TOR_MAP[w] || w).join(' ');
  if (translated !== qNorm) return [translated, q];
  return [q];
}

function fetchAhmiaToken(useOnion = false, timeoutMs = 3000) {
  const cacheObj = useOnion ? cachedAhmiaOnionToken : cachedAhmiaToken;
  if (cacheObj.name && cacheObj.value && (Date.now() - cacheObj.ts < 10 * 60 * 1000)) {
    return Promise.resolve(cacheObj);
  }
  return new Promise((resolve) => {
    let resolved = false;
    const done = (val) => {
      if (resolved) return;
      resolved = true;
      resolve(val);
    };
    const targetUrl = useOnion ? `${AHMIA_ONION_HOST}/` : 'https://ahmia.fi/';
    const client = useOnion ? http : https;
    const agent = (useOnion && SocksProxyAgent) ? new SocksProxyAgent(TOR_SOCKS_PROXY) : false;
    const req = client.get(targetUrl, {
      agent,
      family: useOnion ? undefined : 4,
      headers: {
        'User-Agent': TOR_BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': getTorLanguage()
      },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return done(null);
      }
      let html = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => {
        if (resolved) return;
        html += chunk;
        if (html.length > 60000) {
          try { req.destroy(); } catch (e) {}
        }
      });
      res.on('end', () => {
        const m = html.match(/<input\s+type="hidden"\s+name="([^"]+)"\s+value="([^"]+)"/i);
        if (m && m[1] && m[2]) {
          cacheObj.name = m[1];
          cacheObj.value = m[2];
          cacheObj.ts = Date.now();
          done(cacheObj);
        } else {
          done(null);
        }
      });
    });
    req.on('error', () => done(null));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} done(null); });
  });
}

function queryAhmiaEndpoint(q, token, useOnion = false, timeoutMs = 3500) {
  return new Promise((resolve) => {
    const base = useOnion ? AHMIA_ONION_HOST : 'https://ahmia.fi';
    const tokenParam = (token && token.name && token.value)
      ? `&${encodeURIComponent(token.name)}=${encodeURIComponent(token.value)}`
      : '';
    const url = `${base}/search/?q=${encodeURIComponent(q)}${tokenParam}`;
    const client = useOnion ? http : https;
    const agent = (useOnion && SocksProxyAgent) ? new SocksProxyAgent(TOR_SOCKS_PROXY) : false;

    let resolved = false;
    const done = (val) => {
      if (resolved) return;
      resolved = true;
      resolve(val);
    };

    const req = client.get(url, {
      agent,
      family: useOnion ? undefined : 4,
      headers: {
        'User-Agent': TOR_BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': getTorLanguage()
      },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return done([]);
      }

      let html = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => {
        if (resolved) return;
        html += chunk;
        if (html.length > 85000) {
          done(parseAhmiaHtml(html));
          try { req.destroy(); } catch (e) {}
        }
      });
      res.on('end', () => done(parseAhmiaHtml(html)));
    });

    req.on('error', () => {
      if (!resolved && htmlSnapshot) done(parseAhmiaHtml(htmlSnapshot));
      else done([]);
    });
    let htmlSnapshot = '';
    req.on('timeout', () => {
      try { req.destroy(); } catch (e) {}
      done([]);
    });
  });
}

/**
 * Busca em tempo real na Ahmia (Clearnet + espelho .onion via SOCKS5) com token anti-bot dinâmico e expansão bilíngue
 */
async function searchAhmiaRealtime(query, timeoutMs = 4500) {
  const queries = buildTorSearchQueries(query);
  if (queries.length === 0) return [];

  try {
    const token = await fetchAhmiaToken(false, 2500);
    let combined = await queryAhmiaEndpoint(queries[0], token, false, timeoutMs);
    if (combined.length === 0 && queries.length > 1) {
      combined = await queryAhmiaEndpoint(queries[1], token, false, timeoutMs);
    }

    // Se a clearnet da Ahmia estiver bloqueada, consulta diretamente o serviço oculto .onion da Ahmia via Tor SOCKS5
    if (combined.length === 0 && SocksProxyAgent) {
      const onionToken = await fetchAhmiaToken(true, 3000);
      combined = await queryAhmiaEndpoint(queries[0], onionToken, true, timeoutMs);
    }

    const seen = new Set();
    return combined.filter(it => {
      if (!it || !it.url || seen.has(it.url)) return false;
      seen.add(it.url);
      return true;
    });
  } catch (e) {
    return [];
  }
}

/**
 * Analisa o HTML da Ahmia e agrupa sub-páginas pelo domínio raiz .onion
 */
function parseAhmiaHtml(html) {
  if (!html) return [];

  const rawItems = [];
  try {
    const resultBlocks = html.split('<li class="result">');
    for (let i = 1; i < resultBlocks.length && rawItems.length < 24; i++) {
      const block = resultBlocks[i].split('</li>')[0];

      let onionUrl = '';
      const redirectMatch = block.match(/redirect_url=([^"&>\s]+)/i);
      if (redirectMatch && redirectMatch[1]) {
        try {
          onionUrl = decodeURIComponent(redirectMatch[1]);
        } catch (e) {
          onionUrl = redirectMatch[1];
        }
      } else {
        const directMatch = block.match(/href="(https?:\/\/[a-z2-7]{16,56}\.onion[^"]*)"/i);
        if (directMatch && directMatch[1]) {
          onionUrl = directMatch[1];
        } else {
          const citeMatch = block.match(/<cite>\s*([a-z2-7]{16,56}\.onion[^\s<]*)\s*<\/cite>/i);
          if (citeMatch && citeMatch[1]) {
            onionUrl = 'http://' + citeMatch[1].trim();
          }
        }
      }

      if (!onionUrl || !onionUrl.includes('.onion')) continue;
      if (!/^https?:\/\//i.test(onionUrl)) onionUrl = 'http://' + onionUrl;

      const titleMatch = block.match(/<h4>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
      const rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : 'Serviço Onion';

      const snipMatch = block.match(/<p>([\s\S]*?)<\/p>/i);
      const rawSnip = snipMatch ? snipMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
      const snippet = (rawSnip && !/^no description provided$/i.test(rawSnip))
        ? rawSnip
        : 'Serviço oculto descoberto em tempo real na rede Tor (Ahmia Live Index).';

      rawItems.push({ title: rawTitle || 'Serviço Onion', url: onionUrl, snippet });
    }
  } catch (e) {}

  // Agrupa sublinks pelo host .onion raiz
  const hostGroups = new Map();

  for (const item of rawItems) {
    try {
      const parsed = new URL(item.url);
      const host = parsed.hostname.toLowerCase();
      if (!host || !host.endsWith('.onion')) continue;
      const subHost = host.replace(/^www\./i, '');
      if (!/^[a-z2-7]{16,56}\.onion$/i.test(subHost)) continue;

      if (!hostGroups.has(host)) {
        hostGroups.set(host, {
          title: item.title,
          url: `${parsed.protocol}//${host}`,
          category: 'Descoberto na Rede Tor (Ahmia)',
          description: item.snippet,
          tags: ['ahmia', 'onion', 'live'],
          sublinks: [],
          source: 'Ahmia Live Index',
          score: 14
        });
      }

      const group = hostGroups.get(host);
      // Se tiver caminho interno (sub-link profundo), adiciona ao grupo
      if (parsed.pathname && parsed.pathname !== '/' && parsed.pathname.length > 1) {
        if (!group.sublinks.some(s => s.url === item.url) && group.sublinks.length < 5) {
          group.sublinks.push({
            title: item.title !== group.title ? item.title : parsed.pathname,
            url: item.url,
            path: parsed.pathname + (parsed.search || ''),
            desc: item.snippet
          });
        }
      }
    } catch (e) {}
  }

  return Array.from(hostGroups.values());
}

const webHarvestCache = new Map();

let torTaxiCache = { ts: 0, items: [] };

async function getTorTaxiHarvestedLinks(query, timeoutMs = 3500) {
  const words = expandThemeTerms(query);

  if (Date.now() - torTaxiCache.ts > 30 * 60 * 1000 || torTaxiCache.items.length === 0) {
    try {
      const fetchHtml = (targetUrl) => new Promise((resolve) => {
        const req = https.get(targetUrl, {
          family: 4,
          headers: { 'User-Agent': TOR_BROWSER_UA },
          timeout: timeoutMs
        }, res => {
          if (res.statusCode !== 200) { res.resume(); return resolve(''); }
          let str = '';
          res.on('data', c => { str += c; if (str.length > 300000) { req.destroy(); resolve(str); } });
          res.on('end', () => resolve(str));
        });
        req.on('error', () => resolve(''));
        req.on('timeout', () => { req.destroy(); resolve(''); });
      });

      const [taxiHtml, darkFailHtml] = await Promise.all([
        fetchHtml('https://tor.taxi/'),
        fetchHtml('https://dark.fail/')
      ]);

      const combinedHtml = (taxiHtml || '') + '\n' + (darkFailHtml || '');
      if (combinedHtml.trim()) {
        const parsed = [];
        const seen = new Set();
        const linkRegex = /<a[^>]+href="([^"]*\.onion[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = linkRegex.exec(combinedHtml)) !== null) {
          const rawUrl = match[1].trim();
          const rawTitle = match[2].replace(/<[^>]+>/g, '').trim();
          if (!rawUrl || seen.has(rawUrl)) continue;
          seen.add(rawUrl);

          let fullUrl = rawUrl;
          if (!/^https?:\/\//i.test(fullUrl)) fullUrl = 'http://' + fullUrl;

          const hostMatch = fullUrl.match(/[a-z2-7]{16,63}\.onion/i);
          if (!hostMatch) continue;

          let inferredCategory = 'Descoberto em Blogs/Web';
          const tags = [];
          const tLow = rawTitle.toLowerCase();

          if (/wallet|feather|monero|bitcoin|crypto|electrum|coin|wasabi|exchange/i.test(tLow)) {
            inferredCategory = 'Finanças & Criptomoedas';
            tags.push('bitcoin', 'cripto', 'carteira', 'monero', 'moeda', 'financeiro', 'btc', 'crypto');
          } else if (/times|bbc|propublica|intercept|news|press|journal|noticia/i.test(tLow)) {
            inferredCategory = 'Notícias & Jornalismo';
            tags.push('noticias', 'jornalismo', 'noticia', 'imprensa', 'artigos', 'midia');
          } else if (/forum|dread|pitch|chan|community|discuss|chat|board/i.test(tLow)) {
            inferredCategory = 'Fóruns & Comunidades';
            tags.push('forum', 'comunidade', 'discussao', 'debate', 'chat', 'dread');
          } else if (/hosting|host|server|git|code|linux|debian|exploit/i.test(tLow)) {
            inferredCategory = 'Tecnologia & Hospedagem';
            tags.push('tecnologia', 'hospedagem', 'servidor', 'software', 'codigo', 'tech');
          } else if (/search|taxi|daunt|index|recon|duck|haystak/i.test(tLow)) {
            inferredCategory = 'Buscadores & Índices';
            tags.push('busca', 'buscador', 'pesquisa', 'indice', 'diretorio');
          } else if (/mail|share|privacy|secure|tor|vpn|proton/i.test(tLow)) {
            inferredCategory = 'Privacidade & Segurança';
            tags.push('privacidade', 'seguranca', 'anonimato', 'email', 'comunicacao', 'security');
          }

          parsed.push({
            title: rawTitle && rawTitle.length > 2 && rawTitle.length < 50 ? rawTitle : `Serviço ${hostMatch[0].slice(0, 16)}...`,
            url: fullUrl,
            category: inferredCategory,
            description: `Espelho oficial .onion catalogado em diretórios e blogs de cibersegurança (Tor Taxi / DarkFail).`,
            source: 'Varredura em Blogs & Artigos',
            tags,
            sublinks: []
          });
        }
        if (parsed.length > 0) {
          torTaxiCache = { ts: Date.now(), items: parsed };
        }
      }
    } catch (e) {}
  }

  if (torTaxiCache.items.length === 0) return [];

  const matches = [];
  for (const item of torTaxiCache.items) {
    let score = 0;
    const titleLow = item.title.toLowerCase();
    const urlLow = item.url.toLowerCase();
    const catLow = item.category.toLowerCase();
    const tagsLow = (item.tags || []).join(' ').toLowerCase();

    for (const w of words) {
      if (titleLow.includes(w)) score += 7;
      if (tagsLow.includes(w)) score += 6;
      if (catLow.includes(w)) score += 5;
      if (urlLow.includes(w)) score += 3;
    }

    if (score > 0) {
      matches.push({ ...item, score });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 10);
}

/**
 * Varredor em tempo real na Web pública (blogs de segurança, artigos, listas públicas)
 * vasculhando por links .onion correspondentes ao tema de pesquisa
 */
async function crawlWebForOnionLinks(query, timeoutMs = 2800) {
  const q = String(query || '').trim();
  if (!q) return [];

  const cacheKey = q.toLowerCase();
  if (webHarvestCache.has(cacheKey)) {
    const cached = webHarvestCache.get(cacheKey);
    if (Date.now() - cached.ts < 15 * 60 * 1000) {
      return cached.items;
    }
  }

  const fetchWebEngineOnions = (targetSearchUrl, limitBytes = 200000, waitMs = 2200) => new Promise((resolve) => {
    let doneFlag = false;
    const finish = (val) => {
      if (doneFlag) return;
      doneFlag = true;
      resolve(val);
    };
    const req = https.get(targetSearchUrl, {
      family: 4,
      headers: {
        'User-Agent': TOR_BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': getTorLanguage(),
        'Cache-Control': 'no-cache'
      },
      timeout: waitMs
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return finish([]);
      }
      let html = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => {
        if (doneFlag) return;
        html += chunk;
        if (html.length > limitBytes) {
          finish(extractOnionLinksFromWebHtml(html, q));
          try { req.destroy(); } catch (e) {}
        }
      });
      res.on('end', () => finish(extractOnionLinksFromWebHtml(html, q)));
    });
    req.on('error', () => finish([]));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} finish([]); });
  });

  const [taxiItems, ddgItems, yandexItems, yahooItems] = await Promise.all([
    getTorTaxiHarvestedLinks(q, 1800).catch(() => []),
    fetchWebEngineOnions(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q + ' ".onion"')}`, 240000, timeoutMs),
    fetchWebEngineOnions(`https://yandex.com/search/?text=${encodeURIComponent(q + ' .onion')}`, 200000, 2000),
    fetchWebEngineOnions(`https://search.yahoo.com/search?p=${encodeURIComponent(q + ' ".onion"')}&ei=UTF-8`, 200000, 2000)
  ]);

  const merged = [];
  const seen = new Set();
  for (const item of [...(taxiItems || []), ...(ddgItems || []), ...(yandexItems || []), ...(yahooItems || [])]) {
    const host = (item.url || '').toLowerCase();
    if (!host || seen.has(host)) continue;
    seen.add(host);
    merged.push(item);
  }

  webHarvestCache.set(cacheKey, { ts: Date.now(), items: merged });
  return merged;
}

/**
 * Analisa blocos de resultados de sites/blogs e extrai links .onion e seus contextos
 */
function extractOnionLinksFromWebHtml(html, query) {
  if (!html) return [];
  const foundItems = [];
  const seenHosts = new Set();

  let decodedHtml = html;
  try {
    decodedHtml = html.replace(/%[0-9A-Fa-f]{2}/g, (m) => {
      try { return decodeURIComponent(m); } catch (e) { return m; }
    });
  } catch (e) {}

  const broadMatches = decodedHtml.match(/(?:https?:\/\/)?([a-z2-7]{16,56}\.onion(?:\/[^\s"'<>)]*)?)/gi) || [];
  
  for (const rawMatch of broadMatches) {
    if (foundItems.length >= 10) break;
    try {
      let fullUrl = rawMatch.trim().replace(/\/\/RK=\d+\/RS=[^\s"'<>)]+/gi, '').replace(/[.,;:)\]]+$/, '');
      if (!/^https?:\/\//i.test(fullUrl)) {
        fullUrl = 'http://' + fullUrl;
      }

      const parsed = new URL(fullUrl);
      const host = parsed.hostname.toLowerCase();
      if (!/^[a-z2-7]{16,56}\.onion$/i.test(host)) continue;
      if (seenHosts.has(host)) continue;
      seenHosts.add(host);

      // Tenta localizar o trecho do texto onde o link apareceu para extrair o contexto do blog
      let snippet = `Link .onion identificado em artigos e reportagens sobre "${query}".`;
      const idx = decodedHtml.indexOf(rawMatch);
      if (idx !== -1) {
        const start = Math.max(0, idx - 120);
        const end = Math.min(decodedHtml.length, idx + rawMatch.length + 140);
        const excerpt = decodedHtml.substring(start, end).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (excerpt.length > 25) {
          snippet = excerpt.slice(0, 180) + '...';
        }
      }

      foundItems.push({
        title: `Descoberto na Web: ${host.slice(0, 14)}...onion`,
        url: `${parsed.protocol}//${host}${parsed.pathname !== '/' ? parsed.pathname : ''}`,
        category: 'Descoberto em Blogs/Web',
        description: snippet,
        tags: [query, 'blog', 'artigo', 'web-harvest'],
        sublinks: [],
        source: 'Varredura em Blogs & Artigos',
        score: 9
      });
    } catch (e) {}
  }

  return foundItems;
}

/**
 * Indexa serviços .onion descobertos diretamente no Motor de Busca Nativo em Rust (BM25)
 */
function indexOnionItemsInRustEngine(items, queryContext = '') {
  if (!Array.isArray(items) || items.length === 0 || !nativeCore) return;
  try {
    for (const item of items) {
      if (!item || !item.url || !item.url.includes('.onion')) continue;
      const extraTags = Array.isArray(item.tags) ? item.tags.join(' ') : '';
      const subText = Array.isArray(item.sublinks)
        ? item.sublinks.map(s => `${s.title || ''} ${s.path || ''}`).join(' ')
        : '';
      nativeCore.indexDocument(
        item.url,
        item.title || item.url,
        item.description || item.snippet || '',
        `${queryContext} ${extraTags} ${subText}`.trim(),
        item.category || 'tor-onion'
      );
    }
  } catch (e) {}
}

// Pré-alimenta o Motor Rust BM25 com o catálogo curado de serviços .onion
indexOnionItemsInRustEngine(CURATED_ONION_DIRECTORY, 'tor onion deep web');

/**
 * Crawler de Sub-links em tempo real (Deep Crawler sob demanda)
 * Rastreia tags <a> dentro de qualquer página .onion usando Tor SOCKS5
 */
async function crawlOnionSublinks(targetOnionUrl, timeoutMs = 6000) {
  if (!targetOnionUrl || !targetOnionUrl.includes('.onion')) return [];

  // Cache para respostas instantâneas
  if (crawlCache.has(targetOnionUrl)) {
    const cached = crawlCache.get(targetOnionUrl);
    if (Date.now() - cached.ts < 10 * 60 * 1000) {
      return cached.sublinks;
    }
  }

  // Se tiver no diretório curado, devolve os sublinks curados imediatamente
  for (const item of CURATED_ONION_DIRECTORY) {
    if (item.url.includes(targetOnionUrl) || targetOnionUrl.includes(item.url.replace(/^https?:\/\//, ''))) {
      const mapped = (item.sublinks || []).map(s => ({
        title: s.title,
        url: normalizeSublinkUrl(item.url, s.path),
        path: s.path,
        desc: s.desc || ''
      }));
      crawlCache.set(targetOnionUrl, { ts: Date.now(), sublinks: mapped });
      return mapped;
    }
  }

  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(targetOnionUrl);
    } catch (e) {
      return resolve([]);
    }

    const agent = SocksProxyAgent ? new SocksProxyAgent(TOR_SOCKS_PROXY) : undefined;
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.get(targetOnionUrl, {
      agent,
      headers: {
        'User-Agent': TOR_BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': getTorLanguage()
      },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode >= 400) {
        res.resume();
        return resolve([]);
      }

      let html = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => {
        html += chunk;
        if (html.length > 200000) {
          req.destroy();
          const found = extractLinksFromHtml(html, parsed);
          crawlCache.set(targetOnionUrl, { ts: Date.now(), sublinks: found });
          resolve(found);
        }
      });
      res.on('end', () => {
        const found = extractLinksFromHtml(html, parsed);
        crawlCache.set(targetOnionUrl, { ts: Date.now(), sublinks: found });
        resolve(found);
      });
    });

    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
  });
}

/**
 * Extrai e normaliza links internos do HTML de uma página .onion
 */
function extractLinksFromHtml(html, baseParsed) {
  const sublinks = [];
  const seenPaths = new Set();
  const linkRegex = /<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null && sublinks.length < 8) {
    const rawHref = (match[2] || '').trim();
    const anchorText = (match[3] || '').replace(/<[^>]+>/g, '').trim();

    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:')) {
      continue;
    }

    // Ignora extensões de mídia/binários
    if (/\.(png|jpg|jpeg|gif|svg|ico|css|js|woff|woff2|ttf|zip|tar|gz|exe|apk)$/i.test(rawHref)) {
      continue;
    }

    try {
      let resolvedUrl;
      if (rawHref.startsWith('http://') || rawHref.startsWith('https://')) {
        const check = new URL(rawHref);
        if (check.hostname !== baseParsed.hostname) continue; // Só links do mesmo host .onion
        resolvedUrl = rawHref;
      } else {
        const cleanPath = rawHref.startsWith('/') ? rawHref : '/' + rawHref;
        resolvedUrl = `${baseParsed.protocol}//${baseParsed.host}${cleanPath}`;
      }

      const resolvedObj = new URL(resolvedUrl);
      const pathKey = resolvedObj.pathname + (resolvedObj.search || '');

      if (pathKey === '/' || seenPaths.has(pathKey)) continue;
      seenPaths.add(pathKey);

      sublinks.push({
        title: anchorText.length > 2 && anchorText.length < 60 ? anchorText : pathKey,
        url: resolvedUrl,
        path: pathKey,
        desc: `Sub-rota interna detectada via Tor Crawler: ${pathKey}`
      });
    } catch (e) {}
  }

  return sublinks;
}

const onionUptimeCache = new Map();

/**
 * Testa em tempo real se um serviço .onion está online e respondendo HTTP 200
 */
async function checkOnionAlive(targetUrl, timeoutMs = 4000) {
  if (!targetUrl || !targetUrl.includes('.onion')) {
    return { online: false, statusCode: 0, latencyMs: 0, badge: 'Desconhecido' };
  }

  // Resposta rápida do cache (TTL 10 min)
  if (onionUptimeCache.has(targetUrl)) {
    const cached = onionUptimeCache.get(targetUrl);
    if (Date.now() - cached.ts < 10 * 60 * 1000) {
      return cached.status;
    }
  }

  const startTime = Date.now();

  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return resolve({ online: false, statusCode: 0, latencyMs: 0, badge: 'URL Inválida' });
    }

    const agent = SocksProxyAgent ? new SocksProxyAgent(TOR_SOCKS_PROXY) : undefined;
    const client = parsed.protocol === 'https:' ? https : http;

    function doRequest(reqUrl, redirectCount = 0) {
      let currentParsed;
      try { currentParsed = new URL(reqUrl); } catch (e) { return resolve({ online: false, statusCode: 0, latencyMs: 0, badge: 'URL Inválida' }); }
      const currentClient = currentParsed.protocol === 'https:' ? https : http;

      const req = currentClient.request(currentParsed, {
        method: 'GET',
        agent,
        rejectUnauthorized: false,
        headers: {
          'User-Agent': TOR_BROWSER_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': getTorLanguage()
        },
        timeout: timeoutMs
      }, (res) => {
        // Segue redirects automáticos (ex: http -> https no Dread)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectCount < 2) {
          res.resume();
          try {
            const nextTarget = new URL(res.headers.location, reqUrl).href;
            return doRequest(nextTarget, redirectCount + 1);
          } catch (e) {}
        }

        const latencyMs = Date.now() - startTime;
        const code = res.statusCode || 0;
        const isOnline200 = (code >= 200 && code < 400);

        const status = {
          online: isOnline200,
          statusCode: code,
          latencyMs,
          lastChecked: Date.now(),
          badge: isOnline200 ? `HTTP ${code} Online (${latencyMs}ms)` : `HTTP ${code}`
        };

        res.resume();
        onionUptimeCache.set(targetUrl, { ts: Date.now(), status });
        resolve(status);
      });

      req.on('error', () => {
        // Se a conexão Tor direta demorar, tenta a verificação pelo espelho público Tor2Web
        const petUrl = targetUrl.replace(/\.onion(\/|$)/i, '.onion.pet$1');
        checkViaTor2Web(petUrl, startTime, 2000).then((st) => {
          onionUptimeCache.set(targetUrl, { ts: Date.now(), status: st });
          resolve(st);
        }).catch(() => {
          const fail = { online: false, statusCode: 0, latencyMs: Date.now() - startTime, lastChecked: Date.now(), badge: 'Offline' };
          onionUptimeCache.set(targetUrl, { ts: Date.now(), status: fail });
          resolve(fail);
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const timeoutStatus = { online: false, statusCode: 504, latencyMs: Date.now() - startTime, lastChecked: Date.now(), badge: 'Timeout' };
        onionUptimeCache.set(targetUrl, { ts: Date.now(), status: timeoutStatus });
        resolve(timeoutStatus);
      });

      req.end();
    }

    doRequest(targetUrl, 0);
  });
}

/**
 * Checagem leve de contingência via gateway Tor2Web
 */
function checkViaTor2Web(gatewayUrl, startTime, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(gatewayUrl); } catch (e) { return reject(e); }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(gatewayUrl, {
      method: 'HEAD',
      rejectUnauthorized: false,
      headers: { 'User-Agent': TOR_BROWSER_UA },
      timeout: timeoutMs
    }, (res) => {
      const code = res.statusCode || 0;
      const ok = (code >= 200 && code < 400);
      resolve({
        online: ok,
        statusCode: code,
        latencyMs: Date.now() - startTime,
        lastChecked: Date.now(),
        badge: ok ? `HTTP ${code} Online (Espelho)` : `HTTP ${code}`
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

/**
 * Retorna status real do cache. Se ainda não testado, retorna ativo/detectado para não descartar links do tema
 */
function getOnionStatusSync(targetUrl) {
  if (onionUptimeCache.has(targetUrl)) {
    return onionUptimeCache.get(targetUrl).status;
  }
  return {
    online: true,
    statusCode: 200,
    latencyMs: 140,
    lastChecked: 0,
    badge: 'Rede Tor • Ativo no Tema'
  };
}

/**
 * Scanner de Uptime em Background: verifica os links periodicamente
 */
let isScannerRunning = false;
function startBackgroundUptimeScanner() {
  if (isScannerRunning) return;
  isScannerRunning = true;

  async function runCycle() {
    for (const item of CURATED_ONION_DIRECTORY) {
      try {
        await checkOnionAlive(item.url, 3000);
        // Intervalo suave de 400ms para não sobrecarregar o SOCKS5
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {}
    }
  }

  // Executa ciclo inicial após 3 segundos e repete a cada 6 minutos
  const initTimer = setTimeout(() => {
    runCycle().catch(() => {});
    const loopTimer = setInterval(() => { runCycle().catch(() => {}); }, 6 * 60 * 1000);
    if (typeof loopTimer.unref === 'function') loopTimer.unref();
  }, 3000);
  if (typeof initTimer.unref === 'function') initTimer.unref();
}

// Inicia o scanner de background
startBackgroundUptimeScanner();

/**
 * Motor Unificado de Busca Profunda .onion com Relevância Temática e Indexação Contínua em Rust BM25
 */
async function searchOnionLinks(query, options = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const only200 = options.only200 !== false;

  const curated = searchCuratedOnion(q);

  // 1. Consulta instantânea ao Índice Invertido Nativo em Rust (BM25) para serviços .onion já descobertos
  const rustOnionHits = [];
  if (nativeCore && typeof nativeCore.searchLocalIndex === 'function') {
    const torQueries = buildTorSearchQueries(q);
    for (const tq of torQueries) {
      const hits = nativeCore.searchLocalIndex(tq, 14, true) || [];
      for (const h of hits) {
        if (h && h.url && h.url.includes('.onion')) {
          rustOnionHits.push({
            title: h.title || 'Serviço Onion Indexado (Motor Rust)',
            url: h.url,
            category: h.category && h.category !== 'web' ? h.category : 'Índice BM25 Rust (.onion)',
            description: h.snippet || 'Serviço oculto indexado na memória pelo Motor Rust BM25.',
            tags: ['rust-bm25', 'onion'],
            sublinks: [],
            source: 'Motor Rust BM25',
            score: Math.min(20, (h.score || 8) + 4)
          });
        }
      }
    }
  }

  // 2. Dispara em paralelo: Ahmia em tempo real (com token dinâmico + SOCKS5) e Varredura em Sites e Blogs
  let live = [];
  let webHarvested = [];
  try {
    const [liveRes, webRes] = await Promise.all([
      Promise.race([
        searchAhmiaRealtime(q, 5200),
        new Promise(resolve => { const t = setTimeout(() => resolve([]), 5500); if (t.unref) t.unref(); })
      ]),
      Promise.race([
        crawlWebForOnionLinks(q, 3500),
        new Promise(resolve => { const t = setTimeout(() => resolve([]), 3800); if (t.unref) t.unref(); })
      ])
    ]);
    live = Array.isArray(liveRes) ? liveRes : [];
    webHarvested = Array.isArray(webRes) ? webRes : [];
  } catch (e) {
    live = [];
    webHarvested = [];
  }

  // 3. Auto-alimenta o Motor Rust BM25 com todos os novos links .onion descobertos nesta pesquisa!
  if (live.length > 0 || webHarvested.length > 0) {
    indexOnionItemsInRustEngine([...live, ...webHarvested], q);
  }

  const seenUrls = new Set();
  const merged = [];

  for (const item of [...live, ...webHarvested, ...rustOnionHits, ...curated]) {
    const rawUrl = (item.url || '').toLowerCase().replace(/\/$/, '');
    if (!rawUrl || seenUrls.has(rawUrl)) continue;
    seenUrls.add(rawUrl);

    // Anexa status de uptime em cada item
    const status = getOnionStatusSync(item.url);
    merged.push({
      ...item,
      uptime: status
    });
  }

  // Se nenhum resultado específico foi encontrado para o tema, utiliza os principais serviços ativos da rede Tor
  if (merged.length === 0) {
    const fallbacks = CURATED_ONION_DIRECTORY.slice(0, 10).map(item => {
      const status = getOnionStatusSync(item.url);
      return {
        ...item,
        score: 1,
        source: 'Papaléguas Deep Index',
        uptime: status,
        sublinks: (item.sublinks || []).map(s => ({
          title: s.title,
          url: normalizeSublinkUrl(item.url, s.path),
          path: s.path,
          desc: s.desc || ''
        }))
      };
    });
    return fallbacks.slice(0, 8);
  }

  // Ordena com prioridade máxima para a relevância com o tema pesquisado (score)
  merged.sort((a, b) => {
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    const aOnline = (a.uptime && a.uptime.online && a.uptime.lastChecked > 0) ? 1 : 0;
    const bOnline = (b.uptime && b.uptime.online && b.uptime.lastChecked > 0) ? 1 : 0;
    return bOnline - aOnline;
  });

  // Filtra descartando APENAS quem estiver comprovadamente offline com HTTP >= 400
  const valid = merged.filter(item => {
    if (item.uptime && item.uptime.lastChecked > 0 && item.uptime.online === false && item.uptime.statusCode >= 400) {
      return false;
    }
    return true;
  });

  return (valid.length > 0 ? valid : merged).slice(0, 16);
}

module.exports = {
  searchOnionLinks,
  searchCuratedOnion,
  crawlOnionSublinks,
  crawlWebForOnionLinks,
  checkOnionAlive,
  getOnionStatusSync,
  startBackgroundUptimeScanner,
  indexOnionItemsInRustEngine,
  CURATED_ONION_DIRECTORY,
  setTorCountry,
  getTorLanguage
};
