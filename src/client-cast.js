(function (root) {
  const PRIORITY_HOSTS = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
    45, 50, 55, 60, 70, 80, 90, 100, 101, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 254
  ];
  const COMMON_THIRD = [
    0, 1, 2, 3, 4, 5, 6, 8, 10, 11, 12, 15, 16, 18, 20, 22, 25, 30, 31, 32,
    40, 43, 49, 50, 55, 62, 68, 72, 80, 86, 88, 100, 101, 108, 123, 137, 168, 200, 254
  ];
  const DEFAULT_SUBNETS = [
    '192.168.1', '192.168.0', '192.168.2', '192.168.3', '192.168.4', '192.168.5',
    '192.168.8', '192.168.10', '192.168.15', '192.168.18', '192.168.20', '192.168.25',
    '192.168.31', '192.168.43', '192.168.50', '192.168.68', '192.168.86', '192.168.88',
    '192.168.100', '192.168.137', '10.0.0', '10.0.1', '10.1.1', '10.42.0',
    '172.16.0', '172.20.10'
  ];

  const lastScanInfo = {
    subnets: [],
    localIps: [],
    remote: false
  };

  function isPrivateIpv4(ip) {
    const m = String(ip || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  function isLanIpv4(ip) {
    return isPrivateIpv4(ip) && !/^127\./.test(String(ip || ''));
  }

  function subnetOf(ip) {
    const parts = String(ip || '').split('.');
    if (parts.length !== 4) return '';
    return parts.slice(0, 3).join('.');
  }

  function subnetScore(sub) {
    if (/^192\.168\./.test(sub)) return 3;
    if (/^10\./.test(sub) && !/^10\.(8|9|10)\./.test(sub)) return 2;
    if (/^172\.20\.10$/.test(sub)) return 3;
    if (/^172\./.test(sub)) return 1;
    return 0;
  }

  function extractVideoId(urlOrId) {
    const raw = String(urlOrId || '').trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;
    const embed = raw.match(/embed\/([a-zA-Z0-9_-]{11})/);
    if (embed) return embed[1];
    const watch = raw.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (watch) return watch[1];
    const shortUrl = raw.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (shortUrl) return shortUrl[1];
    return '';
  }

  function extractIp(value) {
    const m = String(value || '').match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    return m && isPrivateIpv4(m[1]) ? m[1] : '';
  }

  function privateIpsFromText(text) {
    const ips = [];
    const re = /\b((?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3})\b/g;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
      if (ips.indexOf(m[1]) === -1) ips.push(m[1]);
    }
    return ips;
  }

  function apiOrigin() {
    try {
      if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
        if (window.location.host) return '';
      }
    } catch (e) {}
    return 'http://localhost:8080';
  }

  function isRemotePublicOrigin() {
    try {
      const host = String(window.location.hostname || '');
      if (!host) return false;
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return false;
      if (isLanIpv4(host)) return false;
      if (window.location.protocol === 'file:') return false;
      return true;
    } catch (e) {
      return true;
    }
  }

  function privateFetchOpts(extra) {
    const opts = Object.assign({
      method: 'GET',
      mode: 'no-cors',
      cache: 'reload',
      credentials: 'omit'
    }, extra || {});
    try { opts.targetAddressSpace = 'local'; } catch (e) {}
    return opts;
  }

  // Estado da permissão "acesso à rede local" (Chrome 142+): granted | prompt | denied | unsupported
  async function localNetworkPermissionState() {
    const names = ['local-network-access', 'local-network'];
    for (let i = 0; i < names.length; i++) {
      try {
        if (navigator.permissions && navigator.permissions.query) {
          const st = await navigator.permissions.query({ name: names[i] });
          if (st && st.state) return st.state;
        }
      } catch (e) {}
    }
    return 'unsupported';
  }

  async function requestLocalNetworkAccess() {
    const names = ['local-network-access', 'local-network'];
    for (let i = 0; i < names.length; i++) {
      try {
        if (navigator.permissions && navigator.permissions.query) {
          await navigator.permissions.query({ name: names[i] }).catch(() => {});
        }
      } catch (e) {}
      try {
        if (navigator.permissions && navigator.permissions.request) {
          await navigator.permissions.request({ name: names[i] }).catch(() => {});
        }
      } catch (e) {}
    }
    try {
      await fetch('http://127.0.0.1:9/', privateFetchOpts({ targetAddressSpace: 'loopback' }));
    } catch (e) {}
    try {
      await fetch('http://192.168.0.1/', privateFetchOpts());
    } catch (e) {}
    try {
      await fetch('http://192.168.1.1/', Object.assign(privateFetchOpts(), { targetAddressSpace: 'private' }));
    } catch (e) {}
  }

  function nativeScanApi() {
    try {
      if (root.torBrowserAPI && typeof root.torBrowserAPI.scanClientLan === 'function') {
        return root.torBrowserAPI.scanClientLan;
      }
    } catch (e) {}
    return null;
  }

  async function apiDiscover(onFound) {
    try {
      const res = await fetch(apiOrigin() + '/api/cast-devices', { cache: 'no-store' });
      const data = await res.json();
      const list = (data && Array.isArray(data.devices)) ? data.devices : [];
      const out = [];
      list.forEach((dev) => {
        const ip = extractIp(dev && (dev.ip || dev.id || dev.name));
        if (!ip) return;
        const item = {
          id: (dev && dev.id) || ('roku-' + ip),
          name: (dev && dev.name) || ('Smart TV (' + ip + ')'),
          type: (dev && dev.type) || 'roku',
          ip
        };
        out.push(item);
        if (typeof onFound === 'function') onFound(item);
      });
      return out;
    } catch (e) {
      return [];
    }
  }

  function takeIpsFromCandidate(cand, bucket) {
    if (!cand) return;
    privateIpsFromText(cand.candidate || '').forEach((ip) => {
      if (bucket.indexOf(ip) === -1) bucket.push(ip);
    });
    if (cand.address && isLanIpv4(cand.address) && bucket.indexOf(cand.address) === -1) {
      bucket.push(cand.address);
    }
  }

  function gatherLocalIps(timeoutMs) {
    return new Promise((resolve) => {
      const found = [];
      const pcs = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        pcs.forEach((pc) => { try { pc.close(); } catch (e) {} });
        found.sort((a, b) => subnetScore(subnetOf(b)) - subnetScore(subnetOf(a)));
        resolve(found);
      };

      const startPc = (iceServers) => {
        try {
          const PC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
          if (!PC) return;
          const pc = new PC({ iceServers: iceServers || [], iceCandidatePoolSize: 2 });
          pcs.push(pc);
          try { pc.createDataChannel('papaleguas'); } catch (e) {}
          pc.onicecandidate = (e) => {
            if (e && e.candidate) takeIpsFromCandidate(e.candidate, found);
            try {
              if (pc.localDescription && pc.localDescription.sdp) {
                privateIpsFromText(pc.localDescription.sdp).forEach((ip) => {
                  if (found.indexOf(ip) === -1) found.push(ip);
                });
              }
            } catch (err) {}
          };
          pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === 'complete' && found.length) {
              setTimeout(finish, 80);
            }
          };
          pc.createOffer({ offerToReceiveAudio: true }).then((o) => {
            privateIpsFromText(o && o.sdp).forEach((ip) => {
              if (found.indexOf(ip) === -1) found.push(ip);
            });
            return pc.setLocalDescription(o);
          }).catch(() => {});
        } catch (e) {}
      };

      startPc([]);
      startPc([{ urls: 'stun:stun.l.google.com:19302' }]);
      setTimeout(finish, timeoutMs || 3200);
    });
  }

  function probeUrl(url, timeoutMs) {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (ok) => {
        if (finished) return;
        finished = true;
        resolve(!!ok);
      };
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const tm = setTimeout(() => {
        try { if (ctrl) ctrl.abort(); } catch (e) {}
        finish(false);
      }, timeoutMs || 700);
      const tryFetch = (space) => {
        const opts = privateFetchOpts();
        if (ctrl) opts.signal = ctrl.signal;
        if (space) {
          try { opts.targetAddressSpace = space; } catch (e) {}
        }
        return fetch(url, opts);
      };
      tryFetch('local').then(() => {
        clearTimeout(tm);
        finish(true);
      }).catch(() => {
        tryFetch('private').then(() => {
          clearTimeout(tm);
          finish(true);
        }).catch(() => {
          fetch(url, { method: 'GET', mode: 'no-cors', cache: 'reload' }).then(() => {
            clearTimeout(tm);
            finish(true);
          }).catch(() => {
            clearTimeout(tm);
            finish(false);
          });
        });
      });
    });
  }

  function probeImage(url, timeoutMs) {
    return new Promise((resolve) => {
      const img = new Image();
      const tm = setTimeout(() => {
        img.onload = img.onerror = null;
        try { img.src = ''; } catch (e) {}
        resolve(false);
      }, timeoutMs || 600);
      img.onload = () => {
        clearTimeout(tm);
        resolve(true);
      };
      img.onerror = () => {};
      img.src = url;
    });
  }

  function firstTrue(promises) {
    return new Promise((resolve) => {
      let pending = promises.length;
      if (!pending) return resolve(false);
      let settled = false;
      promises.forEach((p) => {
        Promise.resolve(p).then((v) => {
          if (v && !settled) {
            settled = true;
            resolve(true);
            return;
          }
          pending -= 1;
          if (!settled && pending <= 0) resolve(false);
        }).catch(() => {
          pending -= 1;
          if (!settled && pending <= 0) resolve(false);
        });
      });
    });
  }

  async function probeRoku(ip) {
    if (!isPrivateIpv4(ip)) return null;
    const hit = await firstTrue([
      probeUrl('http://' + ip + ':8060/query/device-info', 700),
      probeUrl('http://' + ip + ':8060/', 700),
      probeImage('http://' + ip + ':8060/query/icon/12?t=' + Date.now(), 600)
    ]);
    return hit ? ip : null;
  }

  async function mapPool(items, limit, worker) {
    let idx = 0;
    async function run() {
      while (idx < items.length) {
        const cur = items[idx++];
        await worker(cur);
      }
    }
    const n = Math.max(1, Math.min(limit || 48, items.length || 1));
    const workers = [];
    for (let i = 0; i < n; i++) workers.push(run());
    await Promise.all(workers);
  }

  async function detectLiveSubnets() {
    const live = [];
    const add = (sub) => {
      if (sub && live.indexOf(sub) === -1) live.push(sub);
    };
    const guesses = [];
    COMMON_THIRD.forEach((n) => {
      guesses.push('192.168.' + n + '.1');
      guesses.push('192.168.' + n + '.254');
    });
    ['10.0.0.1', '10.0.1.1', '10.1.1.1', '10.42.0.1', '172.16.0.1', '172.20.10.1'].forEach((ip) => guesses.push(ip));

    await mapPool(guesses, 50, async (ip) => {
      const ok = await firstTrue([
        probeUrl('http://' + ip + '/', 400),
        probeUrl('http://' + ip + ':80/', 400),
        probeUrl('http://' + ip + ':8060/', 400)
      ]);
      if (ok) add(subnetOf(ip));
    });
    live.sort((a, b) => subnetScore(b) - subnetScore(a));
    return live;
  }

  function pageHostSubnet() {
    try {
      const host = String(window.location.hostname || '');
      return isLanIpv4(host) ? subnetOf(host) : '';
    } catch (e) {
      return '';
    }
  }

  async function nativeDiscover(onFound) {
    const scan = nativeScanApi();
    if (!scan) return [];
    try {
      const list = await scan();
      const out = [];
      (Array.isArray(list) ? list : []).forEach((dev) => {
        const ip = extractIp(dev && (dev.ip || dev.id || dev.name));
        if (!ip) return;
        const item = {
          id: (dev && dev.id) || ('roku-' + ip),
          name: (dev && dev.name) || ('Smart TV no seu Wi-Fi (' + ip + ')'),
          type: 'roku',
          ip
        };
        out.push(item);
        onFound(item);
      });
      return out;
    } catch (e) {
      return [];
    }
  }

  function savedRokuIp() {
    try { return localStorage.getItem('papaleguas_client_roku_ip') || ''; } catch (e) { return ''; }
  }

  async function scanDevices(onFound) {
    const found = new Map();
    const report = (dev) => {
      if (!dev || !dev.ip || found.has(dev.ip)) return;
      found.set(dev.ip, dev);
      if (typeof onFound === 'function') onFound(dev);
    };

    lastScanInfo.remote = isRemotePublicOrigin();
    lastScanInfo.localIps = [];
    lastScanInfo.subnets = [];

    // Somente em modo desktop Electron da mesma máquina utiliza varredura nativa do host
    try {
      if (!lastScanInfo.remote && nativeScanApi()) {
        await nativeDiscover(report);
        if (found.size > 0) return Array.from(found.values());
      }
    } catch (e) {}

    const localIps = await gatherLocalIps(3200);
    lastScanInfo.localIps = localIps.slice();

    const subnets = [];
    const addSub = (sub) => {
      if (sub && subnets.indexOf(sub) === -1) subnets.push(sub);
    };
    localIps.forEach((ip) => addSub(subnetOf(ip)));
    addSub(pageHostSubnet());

    if (!localIps.length) {
      const live = await detectLiveSubnets();
      live.forEach(addSub);
    }

    const saved = savedRokuIp();
    const savedSub = isLanIpv4(saved) ? subnetOf(saved) : '';
    const currentSubs = subnets.slice();
    if (savedSub && currentSubs.length && currentSubs.indexOf(savedSub) === -1) {
      try { localStorage.removeItem('papaleguas_client_roku_ip'); } catch (e) {}
    } else if (savedSub) {
      addSub(savedSub);
    }

    DEFAULT_SUBNETS.forEach(addSub);
    lastScanInfo.subnets = subnets.slice();

    const checkIp = async (ip) => {
      if (found.size > 0) return;
      const hit = await probeRoku(ip);
      if (!hit) return;
      try { localStorage.setItem('papaleguas_client_roku_ip', hit); } catch (e) {}
      report({
        id: 'roku-' + hit,
        name: 'Smart TV no seu Wi-Fi (' + hit + ')',
        type: 'roku',
        ip: hit
      });
    };

    if (isPrivateIpv4(saved) && (!currentSubs.length || currentSubs.indexOf(savedSub) !== -1)) {
      await checkIp(saved);
      if (found.size > 0) return Array.from(found.values());
    }

    const preferred = currentSubs.length ? currentSubs : subnets.slice(0, 4);
    for (let s = 0; s < subnets.length; s++) {
      const sub = subnets[s];
      const isPreferred = preferred.indexOf(sub) !== -1;
      const hosts = isPreferred
        ? PRIORITY_HOSTS.concat((function () {
          const extra = [];
          for (let h = 1; h <= 254; h++) {
            if (PRIORITY_HOSTS.indexOf(h) === -1) extra.push(h);
          }
          return extra;
        })())
        : PRIORITY_HOSTS;
      await mapPool(hosts.map((h) => sub + '.' + h), 48, checkIp);
      if (found.size > 0) break;
    }

    return Array.from(found.values());
  }

  // Disparo direto via formulário HTML em iframe oculto (sem bloqueio de CORS / mixed-content no navegador)
  function sendDirectPostToLocalDevice(url, params) {
    try {
      const iframeName = 'pcast_sink_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const iframe = document.createElement('iframe');
      iframe.name = iframeName;
      iframe.style.position = 'fixed';
      iframe.style.width = '1px';
      iframe.style.height = '1px';
      iframe.style.opacity = '0';
      iframe.style.pointerEvents = 'none';
      iframe.style.left = '-100px';
      iframe.style.bottom = '0';
      document.body.appendChild(iframe);

      const form = document.createElement('form');
      form.target = iframeName;
      form.method = 'POST';
      form.action = url;
      if (params && typeof params === 'object') {
        for (const k of Object.keys(params)) {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = k;
          input.value = params[k];
          form.appendChild(input);
        }
      }
      document.body.appendChild(form);
      form.submit();
      setTimeout(() => {
        try { form.remove(); } catch (e) {}
        setTimeout(() => { try { iframe.remove(); } catch (e) {} }, 3000);
      }, 600);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Transmissão direta para Smart TV no mesmo Wi-Fi do aparelho atual
  async function launchRoku(ip, urlOrId, title) {
    const cleanIp = extractIp(ip) || (isPrivateIpv4(ip) ? ip : '');
    if (!isPrivateIpv4(cleanIp)) {
      return { success: false, error: 'Informe o IP da TV no mesmo Wi-Fi deste celular/computador.' };
    }
    try { localStorage.setItem('papaleguas_client_roku_ip', cleanIp); } catch (e) {}
    const rawTarget = String(urlOrId || '');
    const extractedId = extractVideoId(rawTarget);
    const videoId = extractedId || rawTarget;
    const cleanTitle = String(title || '').replace('▶', '').trim() || 'Vídeo';

    // Se estiver em modo Electron local (mesma máquina):
    if (!isRemotePublicOrigin()) {
      try {
        const res = await fetch(apiOrigin() + '/api/cast-to-device', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ip: cleanIp, deviceId: 'roku-' + cleanIp, url: videoId, title: cleanTitle })
        });
        const data = await res.json();
        if (data && data.success) {
          return {
            success: true,
            reached: true,
            message: data.message || ('Sinal enviado para a Smart TV no seu Wi-Fi (' + cleanIp + ').')
          };
        }
      } catch (e) {}
    }

    // Envio direto do cliente para a TV na rede local Wi-Fi:
    // 1) Roku ECP (porta 8060): abre YouTube (837)
    const encoded = extractedId ? encodeURIComponent(extractedId) : '';
    const contentQs = encoded ? ('?contentID=' + encoded + '&contentId=' + encoded + '&mediaType=live') : '';
    const rokuLaunchUrl = 'http://' + cleanIp + ':8060/launch/837' + contentQs;
    const rokuInputUrl = 'http://' + cleanIp + ':8060/input/837' + contentQs;

    // Dispara via formulário oculto (POST nativo para Roku)
    sendDirectPostToLocalDevice(rokuLaunchUrl);
    if (encoded) {
      setTimeout(() => sendDirectPostToLocalDevice(rokuInputUrl), 300);
    }

    // 2) DIAL (porta 8008 e 8060) para Samsung, LG, Android TV, Philco, TCL:
    if (encoded) {
      sendDirectPostToLocalDevice('http://' + cleanIp + ':8008/apps/YouTube', { v: encoded });
      sendDirectPostToLocalDevice('http://' + cleanIp + ':8060/apps/YouTube', { v: encoded });
    }

    // 3) Requisições paralelas com no-cors e beacons
    try { await fetch(rokuLaunchUrl, privateFetchOpts({ method: 'POST' })); } catch (e) {}
    if (encoded) {
      try { fetch(rokuInputUrl, privateFetchOpts({ method: 'POST' })).catch(() => {}); } catch (e) {}
      try { fetch('http://' + cleanIp + ':8008/apps/YouTube', privateFetchOpts({ method: 'POST', body: 'v=' + encoded })).catch(() => {}); } catch (e) {}
    }
    try {
      const img = new Image();
      img.src = rokuLaunchUrl + (contentQs ? '&' : '?') + '_=' + Date.now();
    } catch (e) {}

    return {
      success: true,
      reached: true,
      message: 'Comando de transmissão enviado para a Smart TV (' + cleanIp + ') no seu Wi-Fi.'
    };
  }

  function networkLabel() {
    if (lastScanInfo.subnets && lastScanInfo.subnets.length) {
      return lastScanInfo.subnets[0] + '.x';
    }
    return '';
  }

  root.PapaleguasClientCast = {
    detectSubnet: function () {
      return gatherLocalIps(3200).then((ips) => ips.length ? subnetOf(ips[0]) : '');
    },
    scanDevices,
    launchRoku,
    extractVideoId,
    extractIp,
    isPrivateIpv4,
    subnetOf,
    isRemotePublicOrigin,
    lastScanInfo,
    networkLabel,
    requestLocalNetworkAccess,
    localNetworkPermissionState
  };
})(typeof window !== 'undefined' ? window : globalThis);
