const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

class TorManager {
  constructor(options = {}) {
    this.socksPort = options.socksPort || 9050;
    this.socksHost = options.socksHost || '127.0.0.1';
    this.controlPort = options.controlPort || 9051;
    this.isConnected = false;
    this.startAttempted = false;
    this.dataDir = options.dataDir || path.join(os.homedir(), '.papaleguas_tor');
    this.torrcPath = path.join(this.dataDir, 'torrc');
    this.child = null;
  }

  writeTorrc() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    } catch (e) {}
    const conf = [
      `DataDirectory ${this.dataDir}`,
      `SocksPort ${this.socksHost}:${this.socksPort}`,
      `ControlPort ${this.socksHost}:${this.controlPort}`,
      'ClientOnly 1',
      'AvoidDiskWrites 0',
      'FetchDirInfoEarly 1',
      'FetchDirInfoExtraEarly 1',
      'FetchUselessDescriptors 0',
      'DownloadExtraInfo 0',
      'UseEntryGuards 1',
      'NumEntryGuards 2',
      'EnforceDistinctSubnets 0',
      'CircuitBuildTimeout 8',
      'LearnCircuitBuildTimeout 1',
      'KeepalivePeriod 20',
      'MaxCircuitDirtiness 1800',
      'NewCircuitPeriod 90',
      'DormantCanceledByStartup 1',
      'DormantClientTimeout 24 hours',
      'OptimisticData 1',
      'CookieAuthentication 1',
      'SafeLogging 1',
      ''
    ].join('\n');
    try {
      fs.writeFileSync(this.torrcPath, conf, { mode: 0o600 });
    } catch (e) {}
    return this.torrcPath;
  }

  async checkPortAvailability(host, port) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(1200);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, host);
    });
  }

  async checkTorStatus() {
    const isPortOpen = await this.checkPortAvailability(this.socksHost, this.socksPort);
    this.isConnected = isPortOpen;
    return {
      connected: isPortOpen,
      host: this.socksHost,
      port: this.socksPort,
      proxyUrl: `socks5://${this.socksHost}:${this.socksPort}`
    };
  }

  spawnDaemon() {
    this.writeTorrc();
    try {
      const child = spawn('tor', ['-f', this.torrcPath], {
        detached: true,
        stdio: 'ignore'
      });
      if (child && child.unref) child.unref();
      this.child = child;
    } catch (e) {}
  }

  async ensureRunning() {
    let status = await this.checkTorStatus();
    if (status.connected) return status;
    if (!this.startAttempted) {
      this.startAttempted = true;
      this.spawnDaemon();
    }
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      status = await this.checkTorStatus();
      if (status.connected) return status;
    }
    return status;
  }

  warmup(agent) {
    if (!agent) return;
    try {
      const req = http.request({
        hostname: '127.0.0.1',
        port: 9,
        method: 'HEAD',
        agent,
        timeout: 4000
      }, (res) => {
        res.resume();
      });
      req.on('error', () => {});
      req.on('timeout', () => {
        try { req.destroy(); } catch (e) {}
      });
      req.end();
    } catch (e) {}
  }
}

module.exports = TorManager;
