const https = require('https');

async function searchWeb(query, session) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(query);
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encoded}`;

    const { net } = require('electron');
    const req = net.request({
      url: searchUrl,
      session: session,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    let data = '';
    req.on('response', (res) => {
      res.on('data', chunk => data += chunk.toString());
      res.on('end', () => {
        try {
          const results = [];
          // Extrai snippets e links da resposta DuckDuckGo
          const regex = /<a class="result__url" href="([^"]+)".*?>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet".*?>([\s\S]*?)<\/a>/g;
          let match;
          while ((match = regex.exec(data)) !== null && results.length < 5) {
            const rawUrl = match[1].replace(/<\/?[^>]+(>|$)/g, "").trim();
            const snippet = match[3].replace(/<\/?[^>]+(>|$)/g, "").trim();
            results.push({ url: rawUrl, snippet });
          }
          resolve(results);
        } catch (e) {
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.end();
  });
}

module.exports = { searchWeb };
