// =============================================================================
// PAPALÉGUAS TELEGRAM BOT & AGENT BRIDGE
// Permite que robôs e usuários do Telegram recebam vídeos, áudios e tendências
// diretamente no chat, integrados ao motor do Papaléguas BaixaTube.
// =============================================================================

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const CONFIG_PATH = path.join(__dirname, '../papaleguas/data/telegram_bot.json');

let botConfig = {
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  enabled: false,
  username: '',
  webhookUrl: '',
  lastStarted: null,
  totalMessagesProcessed: 0,
  totalDownloadsTriggered: 0
};

// Carrega configurações persistentes se existirem
try {
  if (fs.existsSync(CONFIG_PATH)) {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    botConfig = Object.assign(botConfig, saved);
  }
} catch (e) {}

// Salva configurações
function saveConfig() {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(botConfig, null, 2), 'utf8');
  } catch (e) {}
}

let pollingActive = false;
let pollingTimer = null;
let lastUpdateId = 0;
let dependencies = {};

/**
 * Chamada à API oficial de Bots do Telegram
 */
function callTelegramApi(method, payload = {}) {
  const token = botConfig.token || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return Promise.reject(new Error('TELEGRAM_BOT_TOKEN não configurado.'));

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const reqOptions = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) {
            resolve(parsed.result);
          } else {
            reject(new Error(parsed.description || 'Erro na API do Telegram'));
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout de conexão com o Telegram'));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Extrai o ID do vídeo do YouTube de qualquer formato de link
 */
function extractYoutubeId(text) {
  if (!text) return null;
  const match = String(text).match(/(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/|papaleguas\.app\/baixatube\?v=)([a-zA-Z0-9_-]{6,15})/i);
  return match ? match[1] : null;
}

/**
 * Processa mensagens recebidas (seja por Webhook ou Polling)
 */
async function processIncomingUpdate(update) {
  if (!update) return;

  // 1. Mensagens de Texto
  if (update.message && update.message.text) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    const fromUser = msg.from ? (msg.from.first_name || msg.from.username || 'Amigo') : 'Amigo';

    botConfig.totalMessagesProcessed++;
    saveConfig();

    // Comando /start
    if (text === '/start' || text.startsWith('/start ')) {
      const welcomeText = `🚀 *Olá, ${fromUser}! Bem-vindo ao Robô Oficial do Papaléguas BaixaTube.*\n\n` +
        `Eu entrego vídeos, áudios e tendências diretamente aqui no Telegram sem você precisar ver anúncios!\n\n` +
        `✨ *Como usar:*\n` +
        `• Envie qualquer *link do YouTube* para baixar em MP4 ou MP3.\n` +
        `• Digite */trends* para ver os assuntos mais pesquisados no Google Brasil hoje.\n` +
        `• Digite o *nome de um vídeo ou música* para pesquisar.\n\n` +
        `🌐 *Site Oficial:* [papaleguas.app](https://papaleguas.app/baixatube)`;

      await callTelegramApi('sendMessage', {
        chat_id: chatId,
        text: welcomeText,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔥 Ver Tendências do Momento', callback_data: 'cmd:trends' },
              { text: '🌐 Abrir BaixaTube no Navegador', url: 'https://papaleguas.app/baixatube' }
            ]
          ]
        }
      }).catch(() => {});
      return;
    }

    // Comando /trends
    if (text === '/trends' || text === '/alta' || text === '/emalta') {
      await sendTrendsMessage(chatId);
      return;
    }

    // Comando /help ou /ajuda
    if (text === '/help' || text === '/ajuda') {
      const helpText = `📖 *Ajuda do Papaléguas BaixaTube Bot:*\n\n` +
        `1. *Download de Vídeo / Áudio:* Cole o link do YouTube diretamente aqui na conversa.\n` +
        `2. *Tendências:* Digite /trends para acompanhar o que está bombando no Brasil.\n` +
        `3. *Pesquisa:* Digite o nome de qualquer artista ou notícia.\n\n` +
        `⚡ *100% Gratuito e Sem Anúncios.*`;

      await callTelegramApi('sendMessage', {
        chat_id: chatId,
        text: helpText,
        parse_mode: 'Markdown'
      }).catch(() => {});
      return;
    }

    // Verifica se é link do YouTube
    const ytId = extractYoutubeId(text);
    if (ytId) {
      botConfig.totalDownloadsTriggered++;
      saveConfig();

      let videoTitle = 'Vídeo no Papaléguas BaixaTube';
      if (typeof dependencies.getVideoTitleFast === 'function') {
        try {
          videoTitle = await dependencies.getVideoTitleFast(ytId, videoTitle);
        } catch (e) {}
      }

      const caption = `🎬 *${videoTitle}*\n\n` +
        `Escolha como deseja receber ou assistir este vídeo:\n\n` +
        `🌐 *Papaléguas BaixaTube:* https://papaleguas.app/baixatube?v=${ytId}`;

      const thumbUrl = `https://papaleguas.app/api/thumb/${ytId}.jpg`;

      // Envia com foto e botões interativos de ação direta
      await callTelegramApi('sendPhoto', {
        chat_id: chatId,
        photo: thumbUrl,
        caption: caption,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '▶ Assistir Sem Anúncios', url: `https://papaleguas.app/baixatube?v=${ytId}` }
            ],
            [
              { text: '🎬 Baixar Vídeo MP4', url: `https://papaleguas.app/baixatube?v=${ytId}&action=download_mp4` },
              { text: '🎵 Baixar Áudio MP3', url: `https://papaleguas.app/baixatube?v=${ytId}&action=download_mp3` }
            ]
          ]
        }
      }).catch(async () => {
        // Fallback em caso de erro na imagem
        await callTelegramApi('sendMessage', {
          chat_id: chatId,
          text: caption,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '▶ Assistir Sem Anúncios', url: `https://papaleguas.app/baixatube?v=${ytId}` }
              ],
              [
                { text: '🎬 Baixar MP4', url: `https://papaleguas.app/baixatube?v=${ytId}&action=download_mp4` },
                { text: '🎵 Baixar MP3', url: `https://papaleguas.app/baixatube?v=${ytId}&action=download_mp3` }
              ]
            ]
          }
        }).catch(() => {});
      });
      return;
    }

    // Busca textual simples (quando não é comando nem link)
    const searchUrl = `https://papaleguas.app/baixatube?q=${encodeURIComponent(text)}`;
    await callTelegramApi('sendMessage', {
      chat_id: chatId,
      text: `🔍 *Pesquisar no Papaléguas BaixaTube:*\n\nEncontramos vídeos e notícias recentes para *"${text}"* sem anúncios:`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: `▶ Assistir "${text}"`, url: searchUrl }
          ],
          [
            { text: '🔥 Ver Tendências do Google', callback_data: 'cmd:trends' }
          ]
        ]
      }
    }).catch(() => {});
    return;
  }

  // 2. Resposta de Botões Interativos (Callback Query)
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message ? cb.message.chat.id : null;
    const data = cb.data || '';

    // Confirma clique para remover loading no cliente
    await callTelegramApi('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: 'Carregando informações do Papaléguas...'
    }).catch(() => {});

    if (data === 'cmd:trends' && chatId) {
      await sendTrendsMessage(chatId);
    }
  }
}

/**
 * Envia lista formatada de tendências do Google Trends
 */
async function sendTrendsMessage(chatId) {
  let trends = [];
  if (typeof dependencies.getCachedGoogleTrends === 'function') {
    trends = dependencies.getCachedGoogleTrends('BR') || [];
  }

  if (!trends || !trends.length) {
    await callTelegramApi('sendMessage', {
      chat_id: chatId,
      text: '🔥 *Tendências do Google Brasil:*\n\nAtualizando temas em alta no momento... Acesse: https://papaleguas.app/baixatube',
      parse_mode: 'Markdown'
    }).catch(() => {});
    return;
  }

  const lines = trends.slice(0, 10).map((t, idx) => {
    const safeTitle = t.title.replace(/[_*\[\]()~`>#+-=|{}.!]/g, '\\$&');
    const safeUrl = `https://papaleguas.app/baixatube?q=${encodeURIComponent(t.title)}`;
    const traffic = t.traffic ? ` _(${t.traffic})_` : '';
    return `*${idx + 1}.* [${safeTitle}](${safeUrl})${traffic}`;
  });

  const msg = `🔥 *Top 10 Em Alta no Google Trends (Brasil):*\n_Assuntos mais pesquisados hoje junto com notícias e vídeos:_\n\n` +
    lines.join('\n\n') +
    `\n\n🌐 *Assista sem anúncios:* [papaleguas.app](https://papaleguas.app/baixatube)`;

  await callTelegramApi('sendMessage', {
    chat_id: chatId,
    text: msg,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: '▶ Abrir Tendências no BaixaTube', url: 'https://papaleguas.app/baixatube?q=em+alta' }]
      ]
    }
  }).catch(() => {});
}

/**
 * Loop de Long-Polling para receber mensagens mesmo sem portas públicas abertas
 */
async function startPolling() {
  if (pollingActive) return;
  pollingActive = true;

  console.log('[Telegram Bot] Iniciando serviço de long-polling...');

  const poll = async () => {
    if (!pollingActive || !botConfig.token) return;
    try {
      const updates = await callTelegramApi('getUpdates', {
        offset: lastUpdateId + 1,
        timeout: 25,
        limit: 50
      });

      if (Array.isArray(updates) && updates.length > 0) {
        for (const update of updates) {
          lastUpdateId = Math.max(lastUpdateId, update.update_id);
          await processIncomingUpdate(update);
        }
      }
    } catch (e) {
      // Pequena pausa em caso de falha temporária de rede
      await new Promise(r => setTimeout(r, 4000));
    }

    if (pollingActive) {
      pollingTimer = setTimeout(poll, 500);
    }
  };

  poll();
}

function stopPolling() {
  pollingActive = false;
  if (pollingTimer) clearTimeout(pollingTimer);
}

/**
 * Inicialização do serviço do Telegram
 */
async function init(injectedDeps = {}) {
  dependencies = injectedDeps;

  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  if (envToken && !botConfig.token) {
    botConfig.token = envToken;
    botConfig.enabled = true;
    saveConfig();
  }

  if (botConfig.token) {
    try {
      const botInfo = await callTelegramApi('getMe');
      if (botInfo && botInfo.username) {
        botConfig.username = botInfo.username;
        botConfig.enabled = true;
        botConfig.lastStarted = new Date().toISOString();
        saveConfig();
        console.log(`[Telegram Bot] Conectado com sucesso como @${botInfo.username}!`);

        // Inicia escuta
        startPolling();
      }
    } catch (err) {
      console.warn(`[Telegram Bot] Não foi possível conectar com o token atual: ${err.message}`);
    }
  } else {
    console.log('[Telegram Bot] Token não configurado. Disponível para configuração no painel /papaleguas.');
  }
}

/**
 * Configuração dinâmica via Painel Administrativo ou API
 */
async function setToken(token) {
  const cleanToken = (token || '').trim();
  botConfig.token = cleanToken;
  stopPolling();

  if (!cleanToken) {
    botConfig.enabled = false;
    botConfig.username = '';
    saveConfig();
    return { success: true, message: 'Token removido.' };
  }

  try {
    const botInfo = await callTelegramApi('getMe');
    if (botInfo && botInfo.username) {
      botConfig.username = botInfo.username;
      botConfig.enabled = true;
      botConfig.lastStarted = new Date().toISOString();
      saveConfig();
      startPolling();
      return { success: true, username: botInfo.username, name: botInfo.first_name };
    }
    throw new Error('Falha ao validar bot.');
  } catch (err) {
    botConfig.enabled = false;
    saveConfig();
    throw err;
  }
}

function getStatus() {
  return {
    enabled: botConfig.enabled && !!botConfig.token,
    username: botConfig.username,
    hasToken: !!botConfig.token,
    lastStarted: botConfig.lastStarted,
    messagesProcessed: botConfig.totalMessagesProcessed,
    downloadsTriggered: botConfig.totalDownloadsTriggered,
    pollingActive: pollingActive
  };
}

module.exports = {
  init,
  setToken,
  getStatus,
  processIncomingUpdate,
  callTelegramApi
};
