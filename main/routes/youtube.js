// =========================================================================
// PAPALÉGUAS - MÓDULO MODULAR DE ROTAS: YOUTUBE & BAIXATUBE
// =========================================================================
// Responsável pelas rotas de streaming direto de áudio e vídeo do YouTube,
// downloads (MP4/MP3), thumbnails em cache e jobs de conversão em tempo real.

const fs = require('fs');
const path = require('path');
const https = require('https');

/**
 * Manipulador principal do módulo YouTube / BaixaTube.
 * Retorna true se a requisição foi tratada, ou false caso pertença a outro módulo.
 */
async function handle(req, res, ctx) {
  const { reqUrl, pathname, body = {} } = ctx;

  // -----------------------------------------------------------------------
  // 1. STREAMING DE ÁUDIO DO YOUTUBE (/api/stream-audio)
  // -----------------------------------------------------------------------
  if (pathname === '/api/stream-audio') {
    const title = reqUrl.searchParams.get('title') || body.title || '';
    const artist = reqUrl.searchParams.get('artist') || body.artist || '';
    const videoId = reqUrl.searchParams.get('v') || reqUrl.searchParams.get('id') || body.id || '';
    ctx.handleAudioStreamingProxy(req, res, { title, artist, videoId });
    return true;
  }

  // -----------------------------------------------------------------------
  // 2. STREAMING DE VÍDEO DO YOUTUBE (/api/stream-video)
  // -----------------------------------------------------------------------
  if (pathname === '/api/stream-video') {
    const videoId = reqUrl.searchParams.get('v') || reqUrl.searchParams.get('id') || body.id || body.v || '';
    ctx.handleAudioStreamingProxy(req, res, { videoId, preferVideo: true });
    return true;
  }

  // -----------------------------------------------------------------------
  // 3. RESOLUÇÃO DE STREAM COMPLETO (/api/audio-stream, /api/audio-stream-id)
  // -----------------------------------------------------------------------
  if (pathname === '/api/audio-stream') {
    const title = body.title || reqUrl.searchParams.get('title') || '';
    const artist = body.artist || reqUrl.searchParams.get('artist') || '';
    const result = await ctx.getFullAudioStream({ title, artist });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return true;
  }

  if (pathname === '/api/audio-stream-id') {
    const videoId = body.id || reqUrl.searchParams.get('id') || body.v || reqUrl.searchParams.get('v') || '';
    const result = await ctx.getFullAudioStreamByVideoId(videoId);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return true;
  }

  // -----------------------------------------------------------------------
  // 4. THUMBNAIL DO YOUTUBE (/api/yt-thumb)
  // -----------------------------------------------------------------------
  if (pathname === '/api/yt-thumb') {
    const videoId = String(reqUrl.searchParams.get('v') || reqUrl.searchParams.get('id') || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!videoId) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('v ausente');
      return true;
    }
    const agent = typeof ctx.getOutboundAgent === 'function' ? ctx.getOutboundAgent(false) : undefined;
    https.get('https://i.ytimg.com/vi/' + encodeURIComponent(videoId) + '/hqdefault.jpg', {
      agent: agent,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, (imgRes) => {
      res.writeHead(imgRes.statusCode || 200, {
        'Content-Type': imgRes.headers['content-type'] || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      });
      imgRes.pipe(res);
    }).on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('thumb');
      }
    });
    return true;
  }

  // -----------------------------------------------------------------------
  // 5. DOWNLOAD DIRETO DE MÍDIA (/api/media/download)
  // -----------------------------------------------------------------------
  if (pathname === '/api/media/download') {
    const url = body.url || reqUrl.searchParams.get('url') || '';
    const format = (body.format || reqUrl.searchParams.get('format') || 'mp4').toLowerCase();
    const isDirectDownload = reqUrl.searchParams.get('download') === '1';

    if (!url) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'URL ou ID do vídeo não fornecido' }));
      return true;
    }

    try {
      const media = await ctx.downloadMediaFile(url, format);
      try {
        const clientIp = ctx.papaleguasTracker ? ctx.papaleguasTracker.extractClientIp(req) : '';
        if (ctx.papaleguasTracker && clientIp) {
          ctx.papaleguasTracker.logConversion(clientIp, 'download', { url, format });
        }
      } catch (eConv) {}
      if (isDirectDownload) {
        res.writeHead(302, { 'Location': media.url });
        res.end();
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, ...media }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // 6. MOTOR ASSÍNCRONO DE DOWNLOAD JOBS (/api/media/download-job, status, stream)
  // -----------------------------------------------------------------------
  if (pathname === '/api/media/download-job') {
    const url = reqUrl.searchParams.get('url') || reqUrl.searchParams.get('videoId') || body.url || body.videoId || '';
    const format = (reqUrl.searchParams.get('format') || body.format || 'mp4').toLowerCase();
    const quality = reqUrl.searchParams.get('quality') || reqUrl.searchParams.get('resolution') || body.quality || body.resolution || '720';

    if (!url) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'URL ou ID do vídeo não fornecido' }));
      return true;
    }

    const job = ctx.startMediaDownloadJob(url, format, quality);
    try {
      const clientIp = ctx.papaleguasTracker ? ctx.papaleguasTracker.extractClientIp(req) : '';
      if (ctx.papaleguasTracker && clientIp) {
        ctx.papaleguasTracker.logConversion(clientIp, 'download', { url, format, quality });
      }
    } catch (e) {}
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ success: true, jobId: job.jobId }));
    return true;
  }

  if (pathname === '/api/media/download-status') {
    const jobId = reqUrl.searchParams.get('jobId') || '';
    const job = ctx.mediaJobs ? ctx.mediaJobs.get(jobId) : null;

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });

    if (!job) {
      res.end(JSON.stringify({ success: false, stage: 'not_found', error: 'Job de download não encontrado ou expirado' }));
      return true;
    }

    if (job.stage === 'complete' && job.result) {
      res.end(JSON.stringify({
        success: true,
        stage: 'complete',
        progress: 100,
        text: 'Conversão e download concluídos!',
        ...job.result
      }));
    } else {
      res.end(JSON.stringify({
        success: job.stage !== 'error',
        stage: job.stage,
        progress: job.progress,
        speed: job.speed,
        eta: job.eta,
        total: job.total,
        frag: job.frag,
        text: job.text,
        error: job.error
      }));
    }
    return true;
  }

  if (pathname === '/api/media/download-stream') {
    const url = reqUrl.searchParams.get('url') || '';
    const format = (reqUrl.searchParams.get('format') || 'mp4').toLowerCase();

    if (!url) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'URL ou ID do vídeo não fornecido' }));
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });

    res.write(':\n' + ' '.repeat(4096) + '\n\n');

    function sendSSE(data) {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
    }

    sendSSE({ stage: 'init', progress: 3, text: 'Iniciando motor de download do Papaléguas...' });

    ctx.downloadMediaFile(url, format, (p) => {
      sendSSE(p);
    }).then((result) => {
      sendSSE({ stage: 'complete', progress: 100, success: true, ...result });
      res.end();
    }).catch((err) => {
      sendSSE({ stage: 'error', progress: 0, success: false, error: err.message });
      res.end();
    });

    return true;
  }

  // -----------------------------------------------------------------------
  // 7. DETECÇÃO E RESOLUÇÃO DE MÍDIA (/api/media/detect, play-url)
  // -----------------------------------------------------------------------
  if (pathname === '/api/media/detect') {
    const url = body.url || reqUrl.searchParams.get('url') || '';
    if (!url) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'URL não fornecida' }));
      return true;
    }
    const isYt = url.includes('youtube.com') || url.includes('youtu.be');
    const isDirectVideo = /\.(mp4|webm|m4v|mov|mkv)(\?|$)/i.test(url);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      success: true,
      detected: isYt || isDirectVideo,
      type: isYt ? 'youtube' : (isDirectVideo ? 'direct_video' : 'generic_media'),
      formats: ['mp4', 'mp3']
    }));
    return true;
  }

  if (pathname === '/api/media/play-url') {
    const url = (reqUrl.searchParams.get('url') || body.url || '').trim();
    try {
      const data = await ctx.resolvePlayableMediaUrl(url);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: String(err && err.message || err).slice(0, 200) }));
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // 8. SERVIR ARQUIVOS BAIXADOS (/api/media/file/*)
  // -----------------------------------------------------------------------
  if (pathname.startsWith('/api/media/file/')) {
    const downloadsDir = ctx.MEDIA_DOWNLOADS_DIR;
    const filename = path.basename(pathname.replace('/api/media/file/', ''));
    const filePath = path.join(downloadsDir, filename);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Arquivo de download não encontrado' }));
      return true;
    }

    const stat = fs.statSync(filePath);
    const isMp3 = filename.endsWith('.mp3');
    const contentType = isMp3 ? 'audio/mpeg' : 'video/mp4';
    const customTitle = reqUrl.searchParams.get('title') || filename;
    const ext = isMp3 ? '.mp3' : '.mp4';
    let cleanTitle = customTitle.replace(/[\/\\?%*:|"<>]/g, '_').trim();
    if (cleanTitle.toLowerCase().endsWith(ext)) {
      cleanTitle = cleanTitle.slice(0, -ext.length).trim();
    }
    const asciiTitle = (cleanTitle.replace(/[^\x20-\x7E]/g, '_') || 'download').trim();
    const encodedTitle = encodeURIComponent(cleanTitle) + ext;

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${asciiTitle}${ext}"; filename*=UTF-8''${encodedTitle}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache'
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    return true;
  }

  return false;
}

module.exports = {
  handle
};
