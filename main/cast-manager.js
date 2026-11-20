const { Client: SSDPClient } = require('node-ssdp');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

class CastManager {
  constructor() {
    this.devices = new Map();
    this.ssdpClient = null;
    this.isScanning = false;
    this.lastSubnetScan = 0;
    this.lastFullScan = 0;
    this.bgScanPromise = null;
  }

  getArpIps() {
    const ips = [];
    const own = this.getOwnIpv4s();
    try {
      if (fs.existsSync('/proc/net/arp')) {
        const lines = fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1);
        for (const line of lines) {
          const cols = line.trim().split(/\s+/);
          const ip = cols[0];
          const mac = cols[3];
          if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !own.has(ip) && mac && mac !== '00:00:00:00:00:00') {
            if (!ips.includes(ip)) ips.push(ip);
          }
        }
      }
    } catch (e) {}
    return ips;
  }

  fetchDialFriendlyName(ip, port, timeoutMs) {
    return new Promise((resolve) => {
      const pathStr = port === 8001 ? '/api/v2/' : '/ssdp/device-desc.xml';
      const req = http.get(`http://${ip}:${port}${pathStr}`, { timeout: timeoutMs || 900 }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > 12000) {
            try { res.destroy(); } catch (e) {}
          }
        });
        res.on('end', () => {
          if (port === 8001) {
            try {
              const j = JSON.parse(data);
              const n = j && j.device && (j.device.name || j.device.modelName);
              if (n) return resolve(String(n).trim());
            } catch (e) {}
          }
          const m = data.match(/<friendlyName>(.*?)<\/friendlyName>/i);
          resolve(m && m[1] ? String(m[1]).replace(/<[^>]+>/g, '').trim() : '');
        });
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => {
        try { req.destroy(); } catch (e) {}
        resolve('');
      });
    });
  }

  getLocalSubnets() {
    const subnets = new Set();
    try {
      const ifaces = os.networkInterfaces();
      for (const name of Object.keys(ifaces || {})) {
        for (const iface of ifaces[name] || []) {
          if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal && iface.address) {
            const parts = String(iface.address).split('.');
            if (parts.length === 4) subnets.add(parts.slice(0, 3).join('.'));
          }
        }
      }
    } catch (e) {}
    if (subnets.size === 0) {
      ['192.168.1', '192.168.0', '192.168.15', '10.0.0'].forEach((s) => subnets.add(s));
    }
    return Array.from(subnets);
  }

  getOwnIpv4s() {
    const ips = new Set();
    try {
      const ifaces = os.networkInterfaces();
      for (const name of Object.keys(ifaces || {})) {
        for (const iface of ifaces[name] || []) {
          if ((iface.family === 'IPv4' || iface.family === 4) && iface.address) {
            ips.add(iface.address);
          }
        }
      }
    } catch (e) {}
    return ips;
  }

  tcpOpen(ip, port, timeoutMs) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { socket.destroy(); } catch (e) {}
        resolve(!!ok);
      };
      socket.setTimeout(Math.max(200, timeoutMs || 450));
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      try {
        socket.connect(port, ip);
      } catch (e) {
        finish(false);
      }
    });
  }

  fetchRokuInfo(ip, timeoutMs) {
    return new Promise((resolve) => {
      const req = http.get(`http://${ip}:8060/query/device-info`, { timeout: timeoutMs || 1400 }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > 12000) {
            try { res.destroy(); } catch (e) {}
          }
        });
        res.on('end', () => {
          if (!data || data.indexOf('device-info') === -1 && data.indexOf('<') === -1) {
            resolve({
              id: `roku-${ip}`,
              name: `Smart TV (${ip})`,
              type: 'roku',
              ip,
              port: 8060
            });
            return;
          }
          const friendly = (data.match(/<user-device-name>(.*?)<\/user-device-name>/) ||
            data.match(/<friendly-device-name>(.*?)<\/friendly-device-name>/) ||
            data.match(/<default-device-name>(.*?)<\/default-device-name>/) || [])[1];
          const model = (data.match(/<friendly-model-name>(.*?)<\/friendly-model-name>/) ||
            data.match(/<model-name>(.*?)<\/model-name>/) || [])[1];
          const name = [friendly, model].filter(Boolean).join(' • ') || `Smart TV (${ip})`;
          resolve({
            id: `roku-${ip}`,
            name: String(name).replace(/<[^>]+>/g, '').trim() || `Smart TV (${ip})`,
            type: 'roku',
            ip,
            port: 8060
          });
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        try { req.destroy(); } catch (e) {}
        resolve(null);
      });
    });
  }

  async discoverRokuOnThisMachine(options = {}) {
    this.startDiscovery();
    const now = Date.now();
    const force = Boolean(options && options.force);

    // Se já fizemos varredura recente (< 12s) e temos dispositivos, devolve instantaneamente
    if (!force && this.devices.size > 0 && (now - this.lastFullScan) < 12000) {
      return Array.from(this.devices.values());
    }

    const arpIps = this.getArpIps();
    const priorityHosts = [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 35, 40, 45, 50, 55, 60, 70,
      80, 90, 100, 101, 110, 120, 150, 200, 254
    ];
    const subnets = this.getLocalSubnets();
    const own = this.getOwnIpv4s();
    const seenAll = new Set(arpIps);
    const priorityIps = [];
    const extraIps = [];
    subnets.forEach((sub) => {
      priorityHosts.forEach((h) => {
        const ip = `${sub}.${h}`;
        if (!own.has(ip) && !seenAll.has(ip)) {
          seenAll.add(ip);
          priorityIps.push(ip);
        }
      });
      for (let h = 1; h <= 254; h++) {
        const ip = `${sub}.${h}`;
        if (!own.has(ip) && !seenAll.has(ip)) {
          seenAll.add(ip);
          extraIps.push(ip);
        }
      }
    });

    const found = new Map();
    for (const [, d] of this.devices.entries()) {
      if (d && d.ip) found.set(d.ip, d);
    }

    const probeOneIp = async (ip) => {
      if (!ip) return;
      const [openRoku, openCast, openDial, openSamsung, openLg, openAirplay] = await Promise.all([
        this.tcpOpen(ip, 8060, 280),
        this.tcpOpen(ip, 8009, 280),
        this.tcpOpen(ip, 8008, 280),
        this.tcpOpen(ip, 8001, 280),
        this.tcpOpen(ip, 3000, 280),
        this.tcpOpen(ip, 7000, 280)
      ]);
      if (openRoku) {
        const info = await this.fetchRokuInfo(ip, 900);
        if (info && info.ip) {
          info.lastSeen = Date.now();
          found.set(info.ip, info);
          this.devices.set(info.ip, info);
        }
      } else if (openCast || openDial) {
        let friendly = '';
        if (openDial) friendly = await this.fetchDialFriendlyName(ip, 8008, 700);
        const castDev = {
          id: `cast-${ip}`,
          name: friendly ? `${friendly} (${ip})` : `Chromecast / Google TV (${ip})`,
          type: 'chromecast',
          ip,
          port: openDial ? 8008 : 8009,
          lastSeen: Date.now()
        };
        found.set(ip, castDev);
        this.devices.set(ip, castDev);
      } else if (openSamsung) {
        const friendly = await this.fetchDialFriendlyName(ip, 8001, 700);
        const samDev = {
          id: `samsung-${ip}`,
          name: friendly ? `${friendly} (${ip})` : `Samsung Smart TV (${ip})`,
          type: 'roku',
          ip,
          port: 8001,
          lastSeen: Date.now()
        };
        found.set(ip, samDev);
        this.devices.set(ip, samDev);
      } else if (openLg) {
        const lgDev = {
          id: `lg-${ip}`,
          name: `LG webOS Smart TV (${ip})`,
          type: 'roku',
          ip,
          port: 3000,
          lastSeen: Date.now()
        };
        found.set(ip, lgDev);
        this.devices.set(ip, lgDev);
      } else if (openAirplay) {
        const apDev = {
          id: `airplay-${ip}`,
          name: `Apple TV / AirPlay (${ip})`,
          type: 'chromecast',
          ip,
          port: 7000,
          lastSeen: Date.now()
        };
        found.set(ip, apDev);
        this.devices.set(ip, apDev);
      }
    };

    const run = async (ips, limit) => {
      let idx = 0;
      const worker = async () => {
        while (idx < ips.length) {
          const ip = ips[idx++];
          if (!ip) continue;
          if (!force && found.has(ip)) continue;
          await probeOneIp(ip);
        }
      };
      const n = Math.min(limit || 32, Math.max(4, ips.length));
      await Promise.all(Array.from({ length: n }, () => worker()));
    };

    // Fase 1 ultra-rápida: tabela ARP do kernel Linux (< 400ms)
    if (arpIps.length > 0) {
      await run(arpIps, 24);
    }

    // Se já encontramos TVs na tabela ARP, devolve rápido e completa o resto da sub-rede em segundo plano
    if (found.size > 0 && !options.deep) {
      this.lastFullScan = Date.now();
      if (!this.bgScanPromise) {
        this.bgScanPromise = (async () => {
          try {
            await run(priorityIps, 28);
            await run(extraIps, 32);
            this.lastFullScan = Date.now();
          } finally {
            this.bgScanPromise = null;
          }
        })();
      }
      return Array.from(found.values());
    }

    // Fase 2: IPs prioritários + resto da sub-rede
    await run(priorityIps, 32);
    if (found.size === 0 || options.deep) {
      await run(extraIps, 36);
    }
    this.lastFullScan = Date.now();
    return Array.from(found.values());
  }

  scanLocalSubnets() {
    const now = Date.now();
    if (now - this.lastSubnetScan < 8000) return;
    this.lastSubnetScan = now;

    const hosts = [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 35, 40, 45, 50, 55, 60, 70,
      80, 90, 100, 101, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210,
      220, 230, 240, 250, 254
    ];
    for (const sub of this.getLocalSubnets()) {
      for (const h of hosts) {
        this.probeRoku(`${sub}.${h}`);
      }
    }
  }

  ensureRokuDevice(ip, name = '') {
    const cleanIp = String(ip || '').trim();
    if (!cleanIp) return null;
    const existing = this.devices.get(cleanIp);
    if (existing) {
      existing.lastSeen = Date.now();
      return existing;
    }
    const device = {
      id: `roku-${cleanIp}`,
      name: name || `Smart TV (${cleanIp})`,
      type: 'roku',
      ip: cleanIp,
      port: 8060,
      location: `http://${cleanIp}:8060/`,
      lastSeen: Date.now()
    };
    this.devices.set(cleanIp, device);
    this.probeRoku(cleanIp);
    return device;
  }

  startDiscovery() {
    if (this.isScanning) return;
    this.isScanning = true;
    this.scanLocalSubnets();

    try {
      this.ssdpClient = new SSDPClient();

      this.ssdpClient.on('response', (headers, statusCode, rinfo) => {
        const ip = rinfo && rinfo.address;
        if (!ip || this.getOwnIpv4s().has(ip)) return;
        const location = headers.LOCATION || headers.Location || '';
        const server = headers.SERVER || headers.Server || '';
        const st = headers.ST || headers.st || '';
        const usn = headers.USN || headers.usn || '';
        const blob = `${server} ${st} ${usn} ${location}`.toLowerCase();

        if (blob.includes('roku') || blob.includes('dial') || location.includes(':8060')) {
          if (location) this.fetchRokuDeviceInfo(ip, location);
          else this.probeRoku(ip);
        } else if (blob.includes('mediarenderer') || blob.includes('av-transport') || blob.includes('dlna')) {
          if (location) this.fetchDlnaDeviceInfo(ip, location);
        } else if (blob.includes('chromecast') || blob.includes('googlecast')) {
          this.devices.set(ip, {
            id: `cast-${ip}`,
            name: `Chromecast / Android TV (${ip})`,
            type: 'chromecast',
            ip,
            lastSeen: Date.now()
          });
        } else if (location) {
          this.probeRoku(ip);
        }
      });

      try {
        const ChromecastAPI = require('chromecast-api');
        this.ccClient = new ChromecastAPI();
        this.ccClient.on('device', (d) => {
          const ip = d && d.host;
          if (!ip || this.getOwnIpv4s().has(ip)) return;
          const friendly = (d.friendlyName || d.name || '').trim();
          this.devices.set(ip, {
            id: `cast-${ip}`,
            name: friendly ? `${friendly} (${ip})` : `Chromecast / Google TV (${ip})`,
            type: 'chromecast',
            ip,
            lastSeen: Date.now()
          });
        });
      } catch (e) {}

      this.scan();
      this.scanInterval = setInterval(() => {
        this.scan();
        this.scanLocalSubnets();
      }, 20000);
    } catch (err) {
      console.warn('[CastManager] Erro ao iniciar SSDP:', err.message);
    }
  }

  scan() {
    if (!this.ssdpClient) return;
    try {
      this.ssdpClient.search('ssdp:all');
      this.ssdpClient.search('roku:ecp');
      this.ssdpClient.search('urn:dial-multiscreen-org:service:dial:1');
      this.ssdpClient.search('urn:schemas-upnp-org:device:MediaRenderer:1');
    } catch (e) {}
  }

  fetchRokuDeviceInfo(ip, locationUrl) {
    const url = new URL(locationUrl);
    const queryUrl = `http://${ip}:8060/query/device-info`;

    http.get(queryUrl, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const friendlyNameMatch = data.match(/<user-device-name>(.*?)<\/user-device-name>/) ||
                                  data.match(/<friendly-device-name>(.*?)<\/friendly-device-name>/) ||
                                  data.match(/<default-device-name>(.*?)<\/default-device-name>/);
        const modelMatch = data.match(/<friendly-model-name>(.*?)<\/friendly-model-name>/) ||
                             data.match(/<model-name>(.*?)<\/model-name>/);

        const name = friendlyNameMatch ? friendlyNameMatch[1] : 'Tv Quarto';
        const model = modelMatch ? modelMatch[1] : 'Philco•Roku TV';

        this.devices.set(ip, {
          id: `roku-${ip}`,
          name: `${name} (${model})`,
          type: 'roku',
          ip,
          port: 8060,
          location: `http://${ip}:8060/`,
          lastSeen: Date.now()
        });
      });
    }).on('error', () => {});
  }

  fetchDlnaDeviceInfo(ip, locationUrl) {
    http.get(locationUrl, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const friendlyNameMatch = data.match(/<friendlyName>(.*?)<\/friendlyName>/i);
        const name = friendlyNameMatch ? friendlyNameMatch[1] : `Smart TV (${ip})`;

        this.devices.set(ip, {
          id: `dlna-${ip}`,
          name,
          type: 'dlna',
          ip,
          location: locationUrl,
          lastSeen: Date.now()
        });
      });
    }).on('error', () => {});
  }

  getDevices() {
    // Mantém dispositivos ativos por até 10 minutos
    const now = Date.now();
    for (const [ip, dev] of this.devices.entries()) {
      if (now - dev.lastSeen > 600000) {
        this.devices.delete(ip);
      }
    }
    this.scanLocalSubnets();
    return Array.from(this.devices.values());
  }

  async waitForDevices(timeoutMs = 2200) {
    this.scanLocalSubnets();
    this.scan();
    const wait = Math.max(0, Math.min(5000, Number(timeoutMs) || 0));
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    return this.getDevices();
  }

  probeRoku(ip) {
    const queryUrl = `http://${ip}:8060/query/device-info`;
    http.get(queryUrl, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const friendlyNameMatch = data.match(/<user-device-name>(.*?)<\/user-device-name>/) ||
                                  data.match(/<friendly-device-name>(.*?)<\/friendly-device-name>/) ||
                                  data.match(/<default-device-name>(.*?)<\/default-device-name>/);
        const modelMatch = data.match(/<friendly-model-name>(.*?)<\/friendly-model-name>/) ||
                           data.match(/<model-name>(.*?)<\/model-name>/);
        const name = friendlyNameMatch ? friendlyNameMatch[1] : 'Tv Quarto';
        const model = modelMatch ? modelMatch[1] : 'Roku TV';

        this.devices.set(ip, {
          id: `roku-${ip}`,
          name: `${name} (${model})`,
          type: 'roku',
          ip,
          port: '8060',
          location: `http://${ip}:8060/`,
          lastSeen: Date.now()
        });
      });
    }).on('error', () => {});
  }

  // Extrai um ID de vídeo do YouTube (11 caracteres) de qualquer formato de URL/ID,
  // inclusive das rotas internas do app (/youtube?v=, /filmes?v=, /proxy?url=...).
  extractYouTubeId(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
    // Desembrulha URLs do proxy interno: /proxy?url=<url codificada>
    for (let i = 0; i < 3; i++) {
      const m = s.match(/[?&]url=([^&#]+)/);
      if (!m) break;
      try { s = decodeURIComponent(m[1]); } catch (e) { break; }
    }
    const patterns = [
      /[?&]v=([a-zA-Z0-9_-]{11})/,
      /embed\/([a-zA-Z0-9_-]{11})/,
      /shorts\/([a-zA-Z0-9_-]{11})/,
      /live\/([a-zA-Z0-9_-]{11})/,
      /youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /[?&](?:videoId|video_id|vid)=([a-zA-Z0-9_-]{11})/
    ];
    for (const re of patterns) {
      const m = s.match(re);
      if (m) return m[1];
    }
    return '';
  }

  // Limpa o título capturado do navegador para virar uma busca no YouTube.
  cleanTitleForSearch(title) {
    let t = String(title || '').replace(/[🎬🌐🎵📺▶]/g, '').trim();
    if (!t) return '';
    if (/Carregue um vídeo|Aba Ativa|Nova aba|Vídeo em reprodução|Filmes Online$/i.test(t)) return '';
    t = t.replace(/grátis\s*\|\s*pluto.*$/i, '').replace(/\|\s*pluto.*$/i, '').trim();
    t = t.replace(/\s*[-|–]\s*(YouTube|Papaléguas|BaixaTube|Pluto TV)\s*$/i, '').trim();
    t = t.replace(/^(?:assistir|ver)\s+/i, '').trim();
    if (/^https?:\/\//i.test(t)) return '';
    return t;
  }

  // Transmissão para a TV: sempre abre o YouTube (837) na Roku, em qualquer conexão.
  // Nunca cai em Pluto TV / XCIPTV / outros apps.
  async castToDevice(deviceId, targetUrl, title = '') {
    const device = Array.from(this.devices.values()).find(d => d.id === deviceId);
    if (!device) return { success: false, error: 'Dispositivo não encontrado' };

    if (device.type === 'roku') {
      const YT = '837'; // 837 = YouTube no Roku
      const url = String(targetUrl || '');
      const lower = (url + ' ' + String(title || '')).toLowerCase();

      // 1) Já é um vídeo do YouTube (URL, embed, ID puro ou rota interna do app)
      const directId = this.extractYouTubeId(url) || this.extractYouTubeId(title);
      if (directId) {
        return this.launchRokuApp(device, YT, directId);
      }

      // 2) Temos um título legível: procura o vídeo correspondente no YouTube
      const cleanTitle = this.cleanTitleForSearch(title);
        if (cleanTitle) {
        const isMovie = lower.includes('/filmes') || lower.includes('pluto.tv') || lower.includes('filme');
        const query = isMovie ? `${cleanTitle} filme completo dublado` : cleanTitle;
        const videoId = await this.resolveYouTubeVideoId(query);
          if (videoId) {
          return this.launchRokuApp(device, YT, videoId);
        }
      }

      // 3) Canal ao vivo / stream: procura a transmissão oficial no YouTube
      const isHttp = /^https?:\/\//i.test(url);
      const isLiveStream = lower.includes('.m3u8') || lower.includes('live') || lower.includes('tv');
      if (isLiveStream || (url && !isHttp)) {
        let searchTitle = url.replace(/\(http[^)]+\)/gi, '').trim();
        if (lower.includes('ufc') || lower.includes('combate') || lower.includes('fight')) searchTitle = 'UFC Ao Vivo Combate';
        else if (lower.includes('sbt')) searchTitle = 'SBT Ao Vivo';
        else if (lower.includes('record')) searchTitle = 'Record News Ao Vivo';
        else if (lower.includes('band')) searchTitle = 'Band Ao Vivo';
        else if (lower.includes('jovem')) searchTitle = 'Jovem Pan News Ao Vivo';
        else if (lower.includes('cultura')) searchTitle = 'TV Cultura Ao Vivo';
        else if (lower.includes('globo')) searchTitle = 'Globo Ao Vivo';
        else if (lower.includes('tnt')) searchTitle = 'TNT Brasil Filmes';
        else if (lower.includes('space')) searchTitle = 'Space Filmes Acao';
        else if (lower.includes('sony')) searchTitle = 'Sony Movies Filmes';
        else if (lower.includes('woohoo')) searchTitle = 'Woohoo Esportes';
        else if (lower.includes('tim_bum') || lower.includes('ratimbum')) searchTitle = 'TV Ra Tim Bum';

        if (searchTitle && !/^https?:\/\//i.test(searchTitle)) {
        const videoId = await this.resolveYouTubeVideoId(searchTitle);
        if (videoId) {
            return this.launchRokuApp(device, YT, videoId);
          }
        }
      }

      // 4) Último recurso: abre o app do YouTube na TV (sem conteúdo específico)
      const res = await this.launchRokuApp(device, YT);
      if (res && res.success) {
        res.message = `YouTube aberto em ${device.name}. Não foi possível identificar o vídeo exato; escolha na TV ou transmita a partir do BaixaTube.`;
      }
      return res;
    }

    if (device.type === 'chromecast') {
      const url = String(targetUrl || '');
      let directId = this.extractYouTubeId(url) || this.extractYouTubeId(title);
      if (!directId) {
        const cleanTitle = this.cleanTitleForSearch(title);
        if (cleanTitle) directId = await this.resolveYouTubeVideoId(cleanTitle);
      }
      // Envia via DIAL (porta 8008) para abrir YouTube direto no Chromecast / Google TV / Android TV
      return new Promise((resolve) => {
        const dialBody = directId ? `v=${encodeURIComponent(directId)}` : '';
        const dialReq = http.request({
          hostname: device.ip,
          port: 8008,
          path: '/apps/YouTube',
          method: 'POST',
          timeout: 3000,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Length': Buffer.byteLength(dialBody)
          }
        }, () => {
          resolve({
            success: true,
            message: `Transmitido para ${device.name}!`
          });
        });
        dialReq.on('error', () => {
          resolve({
            success: true,
            message: `Sinal enviado para ${device.name}. Se o YouTube não abrir, use o botão Google Cast.`
          });
        });
        dialReq.on('timeout', () => {
          try { dialReq.destroy(); } catch (e) {}
          resolve({
            success: true,
            message: `Sinal enviado para ${device.name}.`
          });
        });
        if (dialBody) dialReq.write(dialBody);
        dialReq.end();
      });
    }

    return { success: true, message: `Conectado ao dispositivo ${device.name}` };
  }

  resolveYouTubeVideoId(query) {
    const fs = require('fs');
    const ytdlpPath = process.platform === 'win32' ? 'yt-dlp' : (fs.existsSync('/home/nain/.local/bin/yt-dlp') ? '/home/nain/.local/bin/yt-dlp' : 'yt-dlp');
    return new Promise((resolve) => {
      execFile(ytdlpPath, [
        '--extractor-args', 'youtube:player_client=android,ios,web,mweb',
        '--get-id',
        '--no-warnings',
        `ytsearch1:${query}`
      ], { timeout: 15000 }, (err, stdout) => {
        if (stdout && stdout.trim()) {
          // Pega a última linha que tenha tamanho padrão de ID do YouTube (11 caracteres)
          const lines = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
          const validId = lines.find(l => /^[a-zA-Z0-9_-]{11}$/.test(l)) || lines[lines.length - 1];
          resolve(validId || '');
        } else {
          resolve('');
        }
      });
    });
  }

  launchRokuApp(device, channelId, contentUrl = '', mediaType = 'live') {
    return new Promise((resolve) => {
      let queryPath = `/launch/${channelId}`;
      let postData = '';

      if (contentUrl) {
        // Se for YouTube ou embed, extrai o ID de 11 caracteres com precisão
        let videoId = '';
        try {
          // Extrai se for embed/ID
          const embedMatch = contentUrl.match(/embed\/([a-zA-Z0-9_-]{11})/);
          const watchMatch = contentUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
          const shortMatch = contentUrl.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
          const pureMatch = contentUrl.match(/^[a-zA-Z0-9_-]{11}$/);

          if (embedMatch) videoId = embedMatch[1];
          else if (watchMatch) videoId = watchMatch[1];
          else if (shortMatch) videoId = shortMatch[1];
          else if (pureMatch) videoId = contentUrl;
          else {
            const u = new URL(contentUrl.startsWith('http') ? contentUrl : 'https://' + contentUrl);
            videoId = u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop() || '';
          }
        } catch (e) {}

        const idToSend = videoId || contentUrl;
        const encodedId = encodeURIComponent(idToSend);
        queryPath += `?contentID=${encodedId}&contentId=${encodedId}&mediaType=${mediaType}`;

        // Se o aplicativo já estiver em execução na TV, /input/ força a troca imediata da mídia
        try {
          const inputReq = http.request({
            hostname: device.ip,
            port: device.port || 8060,
            path: `/input/${channelId}?contentID=${encodedId}&contentId=${encodedId}&mediaType=${mediaType}`,
            method: 'POST',
            headers: { 'Content-Length': 0 }
          });
          inputReq.on('error', () => {});
          inputReq.end();
        } catch(e) {}
      }

      const req = http.request({
        hostname: device.ip,
        port: 8060,
        path: queryPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': 0
        }
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (body.includes('Limited mode') || res.statusCode === 403) {
            resolve({
              success: false,
              error: `A TV Roku está com 'Controle por apps móveis' em Modo Limitado ou Desativado. Na sua TV, vá em: Configurações > Sistema > Configurações avançadas do sistema > Controle por apps móveis > e mude para 'Habilitado' ou 'Permitido'.`
            });
          } else {
            resolve({
              success: true,
              message: `Transmitido para ${device.name}! O aplicativo foi acionado na TV.`
            });
          }
        });
      });

      req.on('error', (err) => {
        // Fallback DIAL (porta 8008) para TVs Android TV / Samsung / LG
        const dialBody = contentUrl ? `v=${encodeURIComponent(contentUrl.replace(/^.*v=/, ''))}` : '';
        const dialReq = http.request({
          hostname: device.ip,
          port: 8008,
          path: '/apps/YouTube',
          method: 'POST',
          timeout: 2500,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Length': Buffer.byteLength(dialBody)
          }
        }, () => {
          resolve({
            success: true,
            message: `Transmitido para ${device.name} via DIAL!`
          });
        });
        dialReq.on('error', () => {
          resolve({
            success: false,
            error: `Não foi possível iniciar o app diretamente na TV: ${err.message}. Certifique-se de que o controle de rede da TV esteja em 'Habilitado/Permitido'.`
          });
        });
        if (dialBody) dialReq.write(dialBody);
        dialReq.end();
      });

      if (postData) req.write(postData);
      req.end();
    });
  }
}

module.exports = new CastManager();
