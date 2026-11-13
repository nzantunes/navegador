'use strict';
// =========================================================================
// PAPALÉGUAS - MÓDULO MODULAR DE ROTAS: SEO, PWA & FEEDS PÚBLICOS
// =========================================================================
// Responsável por /health, /manifest.json, /sw.js, /ads.txt, /sitemap.xml,
// /robots.txt, /llms.txt, /feed.xml e /feed.json.

const fs = require('fs');
const path = require('path');

async function handlePublicMeta(req, res, ctx) {
  const {
    pathname,
    SRC_DIR,
    SERVER_BUILD_VERSION,
    isTorRoutingEnabled,
    getCachedGoogleTrends,
    serveFileWithMemoryCache,
    escapeHtml
  } = ctx;

  if (pathname === '/health' || pathname === '/api/health') {
    const mem = process.memoryUsage();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      status: 'ok',
      version: SERVER_BUILD_VERSION,
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024)
      },
      torActive: typeof isTorRoutingEnabled === 'function' ? isTorRoutingEnabled() : false,
      app: 'Papaleguas Browser & BaixaTube',
      officialDomain: 'https://papaleguas.app'
    }));
    return true;
  }

  if (pathname === '/manifest.json' || pathname === '/manifest.webmanifest') {
    res.writeHead(200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    const manifestPath = path.join(SRC_DIR, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      res.end(fs.readFileSync(manifestPath, 'utf8'));
    } else {
      res.end(JSON.stringify({
        name: 'Papaléguas BaixaTube',
        short_name: 'Papaléguas',
        start_url: '/',
        id: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0b0d14',
        theme_color: '#0b0d14',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/papaleguas_icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
        ]
      }));
    }
    return true;
  }

  if (pathname === '/sw.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Service-Worker-Allowed': '/',
      'Access-Control-Allow-Origin': '*'
    });
    const swPath = path.join(SRC_DIR, 'sw.js');
    if (fs.existsSync(swPath)) {
      res.end(fs.readFileSync(swPath, 'utf8'));
    } else {
      res.end("self.addEventListener('install', (e) => self.skipWaiting());\nself.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));\nself.addEventListener('fetch', (e) => {});\n");
    }
    return true;
  }

  if (pathname === '/ads.txt') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    });
    const adsTxtPath = path.join(SRC_DIR, 'ads.txt');
    if (fs.existsSync(adsTxtPath)) {
      res.end(fs.readFileSync(adsTxtPath, 'utf8'));
    } else {
      res.end('google.com, pub-5788322050130808, DIRECT, f08c47fec0942fa0\n');
    }
    return true;
  }

  if (pathname === '/sitemap.xml') {
    const sitemapPath = path.join(SRC_DIR, 'sitemap.xml');
    fs.readFile(sitemapPath, 'utf8', (err, baseXml) => {
      if (err || !baseXml) {
        serveFileWithMemoryCache(req, res, sitemapPath, 'application/xml; charset=utf-8', 'public, max-age=1800', true);
        return;
      }
      const trends = getCachedGoogleTrends('BR');
      let enrichedXml = baseXml;
      if (Array.isArray(trends) && trends.length > 0) {
        const trendUrls = trends.slice(0, 10).map((t) => {
          const safeQ = encodeURIComponent(t.title);
          return `  <url>\n    <loc>https://papaleguas.app/baixatube?q=${safeQ}</loc>\n    <lastmod>2026-10-30</lastmod>\n    <changefreq>hourly</changefreq>\n    <priority>0.95</priority>\n  </url>`;
        }).join('\n');
        enrichedXml = baseXml.replace('</urlset>', `${trendUrls}\n</urlset>`);
      }
      res.writeHead(200, {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=1800',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(enrichedXml);
    });
    return true;
  }

  if (pathname === '/robots.txt') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    });
    const robotsPath = path.join(SRC_DIR, 'robots.txt');
    if (fs.existsSync(robotsPath)) {
      res.end(fs.readFileSync(robotsPath, 'utf8'));
    } else {
      res.end('User-agent: *\nAllow: /proxy\nAllow: /proxy-base/\nDisallow: /search\nAllow: /\nSitemap: https://papaleguas.app/sitemap.xml\nSitemap: https://papaleguas.app/feed.xml\n');
    }
    return true;
  }

  if (pathname === '/llms.txt' || pathname === '/llms-full.txt') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    });
    const targetFile = pathname === '/llms-full.txt' ? 'llms-full.txt' : 'llms.txt';
    const llmsPath = path.join(SRC_DIR, targetFile);
    if (fs.existsSync(llmsPath)) {
      res.end(fs.readFileSync(llmsPath, 'utf8'));
    } else {
      res.end('# Papaléguas BaixaTube\nhttps://papaleguas.app/baixatube\n');
    }
    return true;
  }

  if (pathname === '/feed.xml' || pathname === '/rss.xml') {
    const trends = getCachedGoogleTrends('BR') || [];
    const buildDate = new Date().toUTCString();
    let itemsXml = '';
    if (Array.isArray(trends) && trends.length > 0) {
      itemsXml = trends.slice(0, 15).map((t) => {
        const safeTitle = escapeHtml(t.title);
        const safeUrl = `https://papaleguas.app/baixatube?q=${encodeURIComponent(t.title)}`;
        const safeTraffic = t.traffic ? ` (${escapeHtml(t.traffic)})` : '';
        const safeDesc = escapeHtml(`Assista vídeos e notícias em alta sobre "${t.title}"${safeTraffic} sem anúncios no Papaléguas BaixaTube.`);
        return `    <item>\n      <title>${safeTitle}${safeTraffic} - Tendência em Alta</title>\n      <link>${safeUrl}</link>\n      <guid isPermaLink="true">${safeUrl}</guid>\n      <pubDate>${buildDate}</pubDate>\n      <description>${safeDesc}</description>\n      <media:thumbnail url="https://papaleguas.app/og-banner.jpg"/>\n      <media:content url="${safeUrl}" medium="video"/>\n    </item>`;
      }).join('\n');
    }
    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>Papaléguas BaixaTube - Feed de Tendências e Notícias</title>\n    <link>https://papaleguas.app/baixatube</link>\n    <description>Assuntos mais pesquisados no Google Trends Brasil e vídeos em alta sem anúncios no Papaléguas BaixaTube.</description>\n    <language>pt-BR</language>\n    <lastBuildDate>${buildDate}</lastBuildDate>\n    <atom:link href="https://papaleguas.app/feed.xml" rel="self" type="application/rss+xml"/>\n${itemsXml}\n  </channel>\n</rss>`;
    res.writeHead(200, {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=1800',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(rssXml);
    return true;
  }

  if (pathname === '/feed.json' || pathname === '/api/feed.json') {
    const trends = getCachedGoogleTrends('BR') || [];
    const isoDate = new Date().toISOString();
    const items = (trends || []).slice(0, 15).map((t) => {
      const safeUrl = `https://papaleguas.app/baixatube?q=${encodeURIComponent(t.title)}`;
      const traffic = t.traffic ? ` (${t.traffic})` : '';
      return {
        id: safeUrl,
        url: safeUrl,
        title: `${t.title}${traffic} - Em Alta no Google Trends`,
        content_html: `<p>Assista aos vídeos mais recentes sobre <strong>${escapeHtml(t.title)}</strong> sem anúncios no <a href="${safeUrl}">Papaléguas BaixaTube</a>.</p>`,
        image: 'https://papaleguas.app/og-banner.jpg',
        date_published: isoDate
      };
    });
    res.writeHead(200, {
      'Content-Type': 'application/feed+json; charset=utf-8',
      'Cache-Control': 'public, max-age=1800',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1',
      title: 'Papaléguas BaixaTube - Feed de Tendências e Notícias',
      home_page_url: 'https://papaleguas.app/baixatube',
      feed_url: 'https://papaleguas.app/feed.json',
      description: 'Feed em tempo real com as tendências do Google Trends e vídeos mais recentes no Papaléguas BaixaTube.',
      user_comment: 'Feed automatizado para robôs, canais do Telegram, bots do Discord e automações n8n/Zapier.',
      items
    }, null, 2));
    return true;
  }

  return false;
}

module.exports = { handlePublicMeta };
