/**
 * Módulo de Automação & Scraping Dinâmico com Playwright
 * Utilizado para renderizar páginas complexas com JavaScript, contornar
 * desafios de DOM e extrair dados/links .onion de sites dinâmicos.
 */
const { chromium } = require('playwright');

let browserInstance = null;
let browserClosingTimeout = null;

/**
 * Obtém ou inicia uma instância compartilhada e leve do Chromium
 */
async function getBrowser() {
  if (browserClosingTimeout) {
    clearTimeout(browserClosingTimeout);
    browserClosingTimeout = null;
  }

  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--proxy-server=socks5://127.0.0.1:9050',
        '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1, EXCLUDE localhost'
      ]
    });
  }
  return browserInstance;
}

/**
 * Fecha a instância compartilhada se ficar inativa por mais de 45 segundos
 */
function scheduleBrowserIdleClose() {
  if (browserClosingTimeout) clearTimeout(browserClosingTimeout);
  browserClosingTimeout = setTimeout(async () => {
    if (browserInstance && browserInstance.isConnected()) {
      try {
        await browserInstance.close();
      } catch (e) {}
      browserInstance = null;
    }
  }, 45000);
}

/**
 * Carrega uma página de forma dinâmica, aguarda o carregamento do DOM e retorna o HTML
 */
async function fetchDynamicPage(url, options = {}) {
  const timeoutMs = options.timeoutMs || 8000;
  const userAgent = options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  let context = null;
  let page = null;

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent,
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true
    });

    page = await context.newPage();

    // Bloqueia mídias pesadas e fontes para economizar CPU e banda
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type) && !options.allowImages) {
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });

    // Aguarda breve estabilização
    await page.waitForTimeout(options.waitAfterLoad || 800);

    const html = await page.content();
    const title = await page.title();

    return {
      success: true,
      url: page.url(),
      title,
      html
    };
  } catch (err) {
    return {
      success: false,
      url,
      error: err.message,
      html: ''
    };
  } finally {
    if (page) {
      try { await page.close(); } catch (e) {}
    }
    if (context) {
      try { await context.close(); } catch (e) {}
    }
    scheduleBrowserIdleClose();
  }
}

/**
 * Extrai links .onion de páginas dinâmicas ou blogs renderizados via Playwright
 */
async function extractDynamicOnionLinks(url, options = {}) {
  const result = await fetchDynamicPage(url, options);
  if (!result.success || !result.html) return [];

  const html = result.html;
  const broadMatches = html.match(/(?:https?:\/\/)?([a-z2-7]{56}\.onion(?:\/[^\s"'<>]*)?)/gi) || [];
  const found = [];
  const seen = new Set();

  for (const raw of broadMatches) {
    try {
      let full = raw.trim().replace(/[.,;:)\]]+$/, '');
      if (!/^https?:\/\//i.test(full)) full = 'http://' + full;
      const parsed = new URL(full);
      const host = parsed.hostname.toLowerCase();
      if (!/^[a-z2-7]{56}\.onion$/i.test(host)) continue;
      if (seen.has(host)) continue;
      seen.add(host);

      found.push({
        title: `${result.title || 'Serviço'} (${host.slice(0, 12)}...)`,
        url: `${parsed.protocol}//${host}${parsed.pathname !== '/' ? parsed.pathname : ''}`,
        source: 'Playwright Dynamic Harvester',
        category: 'Descoberto em Blogs/Web'
      });
    } catch (e) {}
  }

  return found;
}

module.exports = {
  fetchDynamicPage,
  extractDynamicOnionLinks,
  getBrowser
};
