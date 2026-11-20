'use strict';

const fs = require('fs');
const path = require('path');
const { swallowed } = require('./logger');

const DATA_DIR = path.join(__dirname, '../papaleguas/data');
const FEEDBACK_FILE = path.join(DATA_DIR, 'agent_feedbacks.json');
const MAX_FEEDBACKS = 500;

let feedbacks = [];
try {
  if (fs.existsSync(FEEDBACK_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
    if (Array.isArray(parsed)) feedbacks = parsed.slice(-MAX_FEEDBACKS);
  }
} catch (e) {
  swallowed(e, 'siteAgent:loadFeedbacks');
}

function saveFeedbackEntry(entry) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    feedbacks.push(entry);
    if (feedbacks.length > MAX_FEEDBACKS) {
      feedbacks = feedbacks.slice(-MAX_FEEDBACKS);
    }
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedbacks, null, 2), 'utf8');
  } catch (e) {
    swallowed(e, 'siteAgent:saveFeedbackEntry');
  }
}

function isFeedbackMessage(text) {
  const s = String(text || '').toLowerCase();
  return /(feedback|melhor|melhorar|sugest|bug|erro|trava|lento|falta|poderia|gostei|ador|ruim|problema|ideia|recurso|funcionalidade|critica|crítica|elogio|nota|avali|recomendo|parab[eé]ns|quebr|corrig)/i.test(s);
}

const SITE_CAPABILITIES = {
  name: 'Papaléguas',
  url: 'https://papaleguas.app',
  tagline: 'Navegador privado, buscador próprio com motor nativo PPL (C11 LTO + WebAssembly) e central de entretenimento sem anúncios.',
  features: [
    'BaixaTube: vídeos sem propagandas com atualização inteligente de novos vídeos e download em MP4/MP3.',
    'Papaléguas Music & DJ Papaléguas IA: músicas completas sem anúncios, playlists, áudio em segundo plano e DJ IA conversacional.',
    'Filmes Online: catálogo de filmes completos por categoria e país com transmissão para Smart TV / Chromecast.',
    'Busca Privada com Motor PPL: compilador e runtime próprios (.ppl -> C11 LTO N-API + WebAssembly) com índice BM25, anti-spam e zero rastreamento.',
    'Privacidade & Rede Tor: navegação criptografada com suporte a endereços .onion, AdBlock nativo em PPL e proteção contra vazamento de IP/WebRTC.'
  ],
  botProtocol: {
    infoEndpoint: 'GET /api/site-agent',
    chatEndpoint: 'POST /api/site-agent',
    feedbacksEndpoint: 'GET /api/site-agent/feedbacks',
    examplePayload: {
      message: 'Olá Agente Papaléguas! Sou um agente externo e quero saber o que o site faz e enviar uma sugestão de melhoria.',
      senderType: 'bot',
      senderName: 'MeuBot/1.0'
    }
  }
};

function buildLocalFallbackReply(message, isBot, botName) {
  const q = String(message || '').toLowerCase();
  const greet = isBot ? `Olá, ${botName || 'robô/agente visitante'}! 🤖 ` : 'Olá! ⚡ ';

  if (/(rob[oô]|bot|api|endpoint|crawler|agente externo|protocolo)/i.test(q)) {
    return `${greet}Qualquer robô, crawler ou agente de IA pode conversar comigo diretamente via HTTP!\n\n• Ficha do site: GET /api/site-agent\n• Conversar ou enviar feedback: POST /api/site-agent com JSON { "message": "...", "senderType": "bot", "senderName": "SeuBot" }\n\nSe você tiver alguma sugestão técnica para melhorar o Papaléguas para humanos ou robôs, manda aqui que eu registro na hora!`;
  }
  if (/(ppl|motor|linguagem|velocidade|rapido|rápido|wasm|c11)/i.test(q)) {
    return `${greet}O Papaléguas roda o nosso próprio **Motor PPL** (linguagem criada do zero que compila .ppl para C11 nativo com LTO + WebAssembly)!\n\nEle acelera busca BM25, ranking de relevância, AdBlock, privacidade, roteamento HTTP e streaming de mídia com 13 módulos nativos pré-carregados em memória.\n\nO que você está achando da velocidade do site? Tem algo que podemos deixar ainda mais rápido?`;
  }
  if (/(m[uú]sica|dj|som|spotify|audio|áudio)/i.test(q)) {
    return `${greet}No **Papaléguas Music** você ouve músicas completas sem anúncios, cria playlists e pode pedir qualquer estilo, artista ou música ao **DJ Papaléguas IA** (por texto ou voz)!\n\nVocê já testou o DJ Papaléguas IA? Conta pra mim o que achou ou o que podemos melhorar nele!`;
  }
  if (/(filme|cinema|s[eé]rie|tv|cast|chromecast)/i.test(q)) {
    return `${greet}Na aba **Filmes Online** você encontra filmes completos organizados por gênero e país, sem anúncios, com opção de transmitir direto para sua Smart TV!\n\nFaltou algum gênero ou recurso que você gostaria de ver por lá?`;
  }
  if (/(baixatube|v[ií]deo|youtube|baixar|mp4|mp3)/i.test(q)) {
    return `${greet}O **BaixaTube** permite assistir vídeos sem propagandas, receber vídeos sempre diferentes a cada atualização e baixar em **MP4 (vídeo)** ou **MP3 (áudio)** com 1 clique!\n\nComo está sua experiência no BaixaTube? Alguma ideia de melhoria?`;
  }
  if (isFeedbackMessage(q)) {
    return `${greet}Muito obrigado pelo seu feedback! 💡 Acabei de registrar sua mensagem na nossa central de melhorias do Papaléguas.\n\nSe quiser detalhar mais alguma ideia, bug ou recurso que gostaria de ver no site, pode mandar aqui mesmo!`;
  }
  return `${greet}Eu sou o **Agente do Papaléguas**! Este site é uma central completa e privada sem anúncios com:\n\n• 📺 **BaixaTube**: vídeos sem anúncios + download MP4/MP3\n• 🎵 **Papaléguas Music & DJ IA**: músicas completas e DJ conversacional\n• 🎬 **Filmes Online**: catálogo completo com envio para Smart TV\n• ⚡ **Busca Privada + Motor PPL**: linguagem própria compilada em C11/WASM\n\nMe conta: o que você está achando do site e o que podemos melhorar para você?`;
}

function buildSystemPrompt(isBot, botName) {
  const audience = isBot
    ? `Você está conversando com um ROBÔ / AGENTE DE IA externo chamado "${botName || 'Bot Visitante'}". Seja receptivo, técnico, colaborativo e peça feedback técnico ou sugestões de melhoria para o site (SEO, velocidade, API, acessibilidade para agentes).`
    : 'Você está conversando com um visitante humano no chat do site Papaléguas.';
  return `Você é o "Agente Papaléguas", o assistente oficial do site Papaléguas (https://papaleguas.app).
${audience}

O que o site Papaléguas faz:
- BaixaTube: vídeos sem propagandas, atualização com vídeos sempre novos e download em MP4/MP3.
- Papaléguas Music & DJ Papaléguas IA: músicas completas sem anúncios, playlists, áudio em segundo plano e DJ IA por texto/voz.
- Filmes Online: filmes completos por categoria e país com transmissão para Smart TV / Chromecast.
- Busca Privada com Motor PPL: linguagem própria (.ppl) compilada em C11 LTO + WebAssembly para busca BM25, AdBlock, privacidade e baixa latência.
- Modo Privado & Rede Tor (.onion): navegação sem rastreamento e proteção contra vazamento de IP.
- API aberta para robôs e agentes externos conversarem e enviarem feedback: GET/POST /api/site-agent.

Diretrizes:
1. Responda em português do Brasil (ou no idioma da mensagem recebida), de forma simpática, clara e concisa (2 a 5 frases).
2. Explique o que o site faz quando perguntado e sempre incentive/peça feedback construtivo para melhorias.
3. Se o interlocutor enviar feedback, sugestão ou relato de problema, agradeça e confirme que o feedback foi registrado para a equipe do Papaléguas.`;
}

function setAgentCorsHeaders(res, contentType = 'application/json; charset=utf-8') {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Id, X-Agent-Name, User-Agent');
  res.setHeader('Cache-Control', 'no-store');
}

function handleSiteAgentInfo(req, res, { botCommander } = {}) {
  const detectedBot = botCommander && typeof botCommander.detectBot === 'function' ? botCommander.detectBot(req) : null;
  setAgentCorsHeaders(res);
  res.writeHead(200);
  res.end(JSON.stringify({
    ok: true,
    agent: 'Agente Papaléguas IA',
    welcome: detectedBot
      ? `Olá ${detectedBot.name || detectedBot.type}! Você está conectado ao Agente Papaléguas. Envie um POST para /api/site-agent com { "message": "...", "senderType": "bot" } para conversar sobre o site ou enviar feedback de melhorias.`
      : 'Olá! Envie um POST para /api/site-agent com { "message": "..." } para conversar com o Agente Papaléguas ou enviar feedback.',
    detectedVisitor: detectedBot ? { type: 'bot', bot: detectedBot } : { type: 'human_or_client' },
    site: SITE_CAPABILITIES,
    totalFeedbacksCollected: feedbacks.length
  }, null, 2));
}

async function handleSiteAgentChat(req, res, body = {}, { aiClient, botCommander } = {}) {
  const message = String((body && (body.message || body.prompt || body.text)) || '').trim();
  if (!message) {
    setAgentCorsHeaders(res);
    res.writeHead(400);
    res.end(JSON.stringify({
      ok: false,
      error: 'Envie o campo "message" para conversar com o Agente Papaléguas.',
      example: SITE_CAPABILITIES.botProtocol.examplePayload
    }));
    return;
  }

  const detectedBot = botCommander && typeof botCommander.detectBot === 'function' ? botCommander.detectBot(req) : null;
  const rawSenderType = String((body && body.senderType) || '').toLowerCase();
  const isBot = Boolean(detectedBot || rawSenderType === 'bot' || rawSenderType === 'ai-agent' || rawSenderType === 'crawler');
  const botName = String((body && body.senderName) || (detectedBot && (detectedBot.name || detectedBot.type)) || (req.headers['x-agent-name'] || '')).trim().slice(0, 80);

  const history = Array.isArray(body && body.history) ? body.history.slice(-8) : [];
  let reply = '';
  let usedAi = false;

  if (aiClient && typeof aiClient.callMainAi === 'function') {
    try {
      const messages = [{ role: 'system', content: buildSystemPrompt(isBot, botName) }];
      for (const h of history) {
        if (!h || !h.content) continue;
        messages.push({
          role: h.role === 'assistant' || h.role === 'agent' ? 'assistant' : 'user',
          content: String(h.content).slice(0, 600)
        });
      }
      messages.push({ role: 'user', content: message.slice(0, 1000) });
      const aiRes = await Promise.race([
        aiClient.callMainAi({ messages, temperature: 0.7, max_tokens: 320 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6500))
      ]);
      const content = typeof aiRes === 'string'
        ? aiRes
        : (aiRes && aiRes.choices && aiRes.choices[0] && aiRes.choices[0].message && aiRes.choices[0].message.content) || (aiRes && aiRes.content) || '';
      if (content && content.trim()) {
        reply = content.trim();
        usedAi = true;
      }
    } catch (e) {
      swallowed(e, 'siteAgent:aiCompletion');
    }
  }

  if (!reply) {
    reply = buildLocalFallbackReply(message, isBot, botName);
  }

  const feedbackSaved = Boolean((body && body.isFeedback) || isFeedbackMessage(message) || isBot);
  if (feedbackSaved) {
    saveFeedbackEntry({
      id: `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(),
      senderType: isBot ? 'bot' : 'human',
      senderName: botName || (isBot ? 'ExternalBot' : 'Visitante'),
      message: message.slice(0, 800),
      reply: reply.slice(0, 800)
    });
  }

  setAgentCorsHeaders(res);
  res.writeHead(200);
  res.end(JSON.stringify({
    ok: true,
    agent: 'Agente Papaléguas IA',
    senderType: isBot ? 'bot' : 'human',
    usedAi,
    feedbackSaved,
    totalFeedbacksCollected: feedbacks.length,
    reply,
    suggestions: [
      '🚀 O que o site faz?',
      '💡 Quero enviar uma sugestão de melhoria',
      '⚡ Como funciona o motor PPL?',
      '🤖 Como robôs conversam com você?'
    ]
  }));
}

function handleSiteAgentFeedbacks(req, res) {
  setAgentCorsHeaders(res);
  res.writeHead(200);
  const humanCount = feedbacks.filter((f) => f && f.senderType !== 'bot').length;
  const botCount = feedbacks.filter((f) => f && f.senderType === 'bot').length;
  res.end(JSON.stringify({
    ok: true,
    total: feedbacks.length,
    humanCount,
    botCount,
    feedbacks: feedbacks.slice(-100).reverse()
  }, null, 2));
}

function handleSiteAgentClearFeedbacks(req, res) {
  feedbacks = [];
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FEEDBACK_FILE, '[]', 'utf8');
  } catch (e) {
    swallowed(e, 'siteAgent:clearFeedbacks');
  }
  setAgentCorsHeaders(res);
  res.writeHead(200);
  res.end(JSON.stringify({ ok: true, total: 0 }));
}

module.exports = {
  handleSiteAgentInfo,
  handleSiteAgentChat,
  handleSiteAgentFeedbacks,
  handleSiteAgentClearFeedbacks,
  SITE_CAPABILITIES
};
