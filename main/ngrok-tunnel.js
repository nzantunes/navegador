// main/ngrok-tunnel.js - Túnel ngrok desativado permanentemente
// O túnel oficial utilizado é o Cloudflare Tunnel (https://papaleguas.app)

const { execFileSync } = require('child_process');

function killStrayNgrok() {
  try {
    execFileSync('pkill', ['-9', '-f', 'ngrok http'], { stdio: 'ignore', timeout: 3000 });
  } catch (e) {}
}

killStrayNgrok();

function startTunnel() {
  killStrayNgrok();
  return null;
}

function stopTunnel() {
  killStrayNgrok();
}

function getTunnelUrl() {
  return null;
}

function getTunnelStatus() {
  return {
    running: false,
    connecting: false,
    url: null,
    disabled: true
  };
}

module.exports = {
  startTunnel,
  stopTunnel,
  getTunnelUrl,
  getTunnelStatus
};
