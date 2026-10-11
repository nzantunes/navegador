const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

function readKeyFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      if (raw && !raw.startsWith('#')) return raw.split(/\r?\n/)[0].trim();
    }
  } catch (e) {}
  return '';
}

function loadDotEnv() {
  const candidates = [
    path.join(__dirname, '../.env'),
    path.join(os.homedir(), '.papaleguas', '.env')
  ];
  candidates.forEach((filePath) => {
    try {
      if (!fs.existsSync(filePath)) return;
      fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line) => {
        const trimmed = String(line || '').trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eq = trimmed.indexOf('=');
        if (eq < 1) return;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (key && !process.env[key]) process.env[key] = value;
      });
    } catch (e) {}
  });
}

loadDotEnv();

function loadXaiKey() {
  return process.env.XAI_API_KEY ||
    process.env.GROK_API_KEY ||
    readKeyFile(path.join(os.homedir(), '.papaleguas', 'xai.key')) ||
    readKeyFile(path.join(__dirname, '../.xai_key')) ||
    '';
}

let openaiFallbackKey = process.env.OPENAI_API_KEY || '';
let xaiKey = loadXaiKey();

const GROK_MODEL = process.env.GROK_MODEL || 'grok-4.6';
const GROK_FALLBACK_MODELS = ['grok-4.6', 'grok-4', 'grok-3-mini'];
const GROK_ENABLED = process.env.GROK_ENABLED === '1';

function setOpenAiFallbackKey(key) {
  if (key) openaiFallbackKey = key;
}

function refreshXaiKey() {
  xaiKey = loadXaiKey();
  return xaiKey;
}

function hasGrok() {
  return GROK_ENABLED && !!xaiKey;
}

let outboundAgent;

function setOutboundAgent(agent) {
  outboundAgent = agent || undefined;
}

function httpsJson({ hostname, reqPath, headers, body, timeoutMs, direct }) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body || {});
    const req = https.request({
      hostname,
      path: reqPath,
      method: 'POST',
      // direct: sai pela internet normal mesmo com o Tor ligado (ex.: DJ Papaléguas Music)
      agent: direct ? undefined : outboundAgent,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }, headers || {})
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error((data || e.message || 'Resposta inválida').slice(0, 280)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 45000, () => {
      req.destroy();
      reject(new Error('Timeout da IA'));
    });
    req.write(postData);
    req.end();
  });
}

function isUsableChatResponse(data) {
  return !!(data && !data.error && data.choices && data.choices[0] && data.choices[0].message);
}

async function callGrok(payload) {
  if (!xaiKey) throw new Error('XAI_API_KEY não configurada');
  const requested = payload && payload.model && !/^gpt-/i.test(payload.model) ? payload.model : GROK_MODEL;
  const models = [requested].concat(GROK_FALLBACK_MODELS).filter((m, i, arr) => m && arr.indexOf(m) === i);
  let lastError = new Error('Grok indisponível');

  const direct = !!(payload && payload.direct);
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const body = Object.assign({}, payload, { model });
      delete body.direct;
      delete body.timeoutMs;
      const data = await httpsJson({
        hostname: 'api.x.ai',
        reqPath: '/v1/chat/completions',
        headers: { Authorization: 'Bearer ' + xaiKey },
        body,
        timeoutMs: Number(payload && payload.timeoutMs) || 45000,
        direct
      });
      if (data && data.error) {
        lastError = new Error(data.error.message || 'Erro Grok');
        continue;
      }
      if (isUsableChatResponse(data)) {
        data._provider = 'grok';
        data._model = model;
        return data;
      }
      lastError = new Error('Resposta vazia do Grok');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function callOpenAi(payload) {
  return new Promise((resolve, reject) => {
    if (!openaiFallbackKey) {
      reject(new Error('Nenhuma chave de IA configurada'));
      return;
    }
    const timeoutMs = Number(payload && payload.timeoutMs) || 15000;
    const body = Object.assign({ model: 'gpt-4o-mini' }, payload || {});
    delete body.timeoutMs;
    delete body.direct;

    const requestDirect = () => {
      httpsJson({
        hostname: 'api.openai.com',
        reqPath: '/v1/chat/completions',
        headers: { Authorization: 'Bearer ' + openaiFallbackKey },
        body,
        timeoutMs: 15000,
        direct: true
      }).then((data) => {
        if (data && data.error) return reject(new Error(data.error.message || 'Erro OpenAI'));
        if (data) {
          data._provider = 'openai';
          data._model = body.model;
        }
        resolve(data);
      }).catch(reject);
    };

    // Chamadas de IA para a OpenAI: usa conexão direta estável para evitar bloqueios de Tor
    if (payload && payload.direct !== false) {
      requestDirect();
    } else {
      httpsJson({
        hostname: 'api.openai.com',
        reqPath: '/v1/chat/completions',
        headers: { Authorization: 'Bearer ' + openaiFallbackKey },
        body,
        timeoutMs: Math.min(timeoutMs, 6000),
        direct: false
      }).then((data) => {
        if (data && data.error) return requestDirect();
        if (data) {
          data._provider = 'openai';
          data._model = body.model;
        }
        resolve(data);
      }).catch((err) => {
        console.warn('[IA] Falha via Tor, alternando chamada OpenAI para conexão direta...');
        requestDirect();
      });
    }
  });
}

async function callMainAi(payload) {
  if (GROK_ENABLED) {
    refreshXaiKey();
    if (xaiKey) {
      try {
        const grokPayload = Object.assign({}, payload || {});
        if (!grokPayload.model || /^gpt-/i.test(grokPayload.model)) {
          grokPayload.model = GROK_MODEL;
        }
        return await callGrok(grokPayload);
      } catch (err) {
        console.warn('[IA] Grok falhou, usando OpenAI:', err && err.message ? err.message : err);
      }
    }
  }
  return callOpenAi(payload);
}

function providerLabel() {
  return hasGrok() ? 'Grok' : 'OpenAI';
}

module.exports = {
  callMainAi,
  callGrok,
  callOpenAi,
  setOpenAiFallbackKey,
  setOutboundAgent,
  refreshXaiKey,
  hasGrok,
  providerLabel,
  GROK_ENABLED,
  GROK_MODEL
};
