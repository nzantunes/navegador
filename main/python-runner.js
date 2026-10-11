const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');

// Diretório base para as aplicações e scripts Python do Papaléguas
const APPS_DIR = path.join(os.homedir(), '.papaleguas_python_apps');
if (!fs.existsSync(APPS_DIR)) {
  try {
    fs.mkdirSync(APPS_DIR, { recursive: true });
  } catch (e) {}
}

const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

// Mapeamento de imports para pacotes no PyPI (pip)
const KNOWN_MODULE_PACKAGES = {
  'flask': 'flask',
  'fastapi': 'fastapi uvicorn',
  'uvicorn': 'uvicorn',
  'pydantic': 'pydantic',
  'starlette': 'starlette',
  'requests': 'requests',
  'numpy': 'numpy',
  'pandas': 'pandas',
  'matplotlib': 'matplotlib',
  'seaborn': 'seaborn',
  'scipy': 'scipy',
  'sklearn': 'scikit-learn',
  'cv2': 'opencv-python',
  'PIL': 'pillow',
  'pillow': 'pillow',
  'bs4': 'beautifulsoup4',
  'yaml': 'pyyaml',
  'dotenv': 'python-dotenv',
  'bottle': 'bottle',
  'tornado': 'tornado',
  'aiohttp': 'aiohttp',
  'streamlit': 'streamlit',
  'dash': 'dash',
  'pygame': 'pygame',
  'qrcode': 'qrcode[pil]',
  'gtts': 'gtts',
  'rich': 'rich',
  'tqdm': 'tqdm',
  'faker': 'faker',
  'psutil': 'psutil',
  'jinja2': 'jinja2',
  'werkzeug': 'werkzeug',
  'colorama': 'colorama',
  'tabulate': 'tabulate'
};

// Módulos padrão da Standard Library do Python (não precisam de pip)
const STANDARD_MODULES = new Set([
  'os', 'sys', 'time', 'datetime', 'json', 'math', 'random', 're',
  'string', 'collections', 'itertools', 'functools', 'urllib', 'http',
  'socket', 'threading', 'multiprocessing', 'subprocess', 'shutil',
  'pathlib', 'tempfile', 'io', 'base64', 'hashlib', 'sqlite3', 'csv',
  'unittest', 'logging', 'argparse', 'typing', 'enum', 'uuid', 'copy',
  'traceback', 'inspect', 'platform', 'signal', 'select', 'queue', 'ssl'
]);

// Map para rastrear servidores Python ativos
const activePythonServers = new Map();

// Histórico de servidores encerrados recentemente (últimos 20) para consulta de logs
const recentServersHistory = [];
function recordServerHistory(entry) {
  recentServersHistory.unshift(entry);
  if (recentServersHistory.length > 20) recentServersHistory.pop();
}

function getServerLogs(portOrAppId) {
  const query = String(portOrAppId || '').trim();
  for (const [id, s] of activePythonServers.entries()) {
    if (id === query || String(s.port) === query) {
      return {
        active: true,
        port: s.port,
        appId: id,
        stdout: typeof s.getStdout === 'function' ? s.getStdout() : '',
        stderr: typeof s.getStderr === 'function' ? s.getStderr() : ''
      };
    }
  }
  const hist = recentServersHistory.find(h => h.appId === query || String(h.port) === query);
  if (hist) {
    return {
      active: false,
      port: hist.port,
      appId: hist.appId,
      exitCode: hist.exitCode,
      stdout: hist.stdout || '',
      stderr: hist.stderr || ''
    };
  }
  return { active: false, stdout: '', stderr: 'Nenhum log encontrado para este servidor.' };
}

/**
 * Encontra uma porta TCP livre dinamicamente a partir de startPort
 */
function getFreePort(startPort = 5001) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(startPort, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', () => {
      resolve(getFreePort(startPort + 1));
    });
  });
}

/**
 * Extrai módulos importados no código Python
 */
function extractImports(code) {
  const imports = new Set();
  const importRegex = /(?:^|\n)[ \t]*(?:import[ \t]+([a-zA-Z0-9_, \t]+)|from[ \t]+([a-zA-Z0-9_.]+)[ \t]+import)/g;
  let match;

  while ((match = importRegex.exec(code)) !== null) {
    if (match[1]) {
      match[1].split(',').forEach(mod => {
        const rootMod = mod.trim().split(/\s+/)[0].split('.')[0];
        if (rootMod && !STANDARD_MODULES.has(rootMod)) imports.add(rootMod);
      });
    } else if (match[2]) {
      const rootMod = match[2].trim().split('.')[0];
      if (rootMod && !STANDARD_MODULES.has(rootMod)) imports.add(rootMod);
    }
  }

  // Garantias automáticas para frameworks comuns
  if (/\bfastapi\b/i.test(code)) {
    imports.add('fastapi');
    imports.add('uvicorn');
  }
  if (/\bpydantic\b/i.test(code)) {
    imports.add('pydantic');
  }
  if (/\bflask\b/i.test(code)) {
    imports.add('flask');
  }

  return Array.from(imports);
}

/**
 * Verifica se um módulo já está instalado no Python
 */
function isModuleInstalled(moduleName) {
  return new Promise((resolve) => {
    exec(`${PYTHON_CMD} -c "import ${moduleName}"`, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Instala pacotes via pip de forma automática
 */
async function installMissingPackages(modules = []) {
  const toInstall = [];

  for (const mod of modules) {
    const installed = await isModuleInstalled(mod);
    if (!installed) {
      const pkgName = KNOWN_MODULE_PACKAGES[mod] || mod;
      toInstall.push(pkgName);
    }
  }

  if (toInstall.length === 0) return { success: true, installed: [] };

  const uniquePackages = Array.from(new Set(toInstall));
  console.log(`[PYTHON RUNNER] Instalando bibliotecas necessárias via pip: ${uniquePackages.join(', ')}...`);

  return new Promise((resolve) => {
    const extraFlags = process.platform === 'win32' ? '' : '--break-system-packages';
    const cmd = `${PYTHON_CMD} -m pip install --user ${extraFlags} ${uniquePackages.join(' ')}`;
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[PYTHON RUNNER] Erro ao instalar dependências:', stderr || err.message);
        resolve({ success: false, error: stderr || err.message, installed: [] });
      } else {
        console.log('[PYTHON RUNNER] Dependências instaladas com sucesso!');
        resolve({ success: true, installed: uniquePackages });
      }
    });
  });
}

/**
 * Detecta se o código é uma aplicação web ou servidor
 */
function isWebServerCode(code) {
  const patterns = [
    /\bflask\b/i,
    /\bapp\.run\b/i,
    /\bfastapi\b/i,
    /\buvicorn\b/i,
    /\bhttp\.server\b/i,
    /\bSimpleHTTPRequestHandler\b/i,
    /\bTCPServer\b/i,
    /\bHTTPServer\b/i,
    /\bbottle\b/i,
    /\btornado\b/i,
    /\baiohttp\b/i,
    /\bstreamlit\b/i,
    /\bdash\b/i,
    /\bserver\.listen\b/i
  ];
  return patterns.some(p => p.test(code));
}

/**
 * Aguarda a porta do servidor responder
 */
function waitForPort(port, timeoutMs = 8000) {
  const startTime = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const client = new net.Socket();
      client.setTimeout(400);

      client.on('connect', () => {
        client.destroy();
        resolve(true);
      });

      client.on('error', () => {
        client.destroy();
        if (Date.now() - startTime >= timeoutMs) {
          resolve(false);
        } else {
          setTimeout(check, 250);
        }
      });

      client.on('timeout', () => {
        client.destroy();
        if (Date.now() - startTime >= timeoutMs) {
          resolve(false);
        } else {
          setTimeout(check, 250);
        }
      });

      client.connect(port, '127.0.0.1');
    };

    check();
  });
}

/**
 * Verifica a saúde real do servidor HTTP fazendo uma requisição de teste
 */
function verifyServerHealth(port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const hasFatalError = body.includes('TemplateNotFound') || 
                              body.includes('Traceback (most recent call last)') || 
                              res.statusCode >= 500;
        resolve({
          healthy: !hasFatalError,
          statusCode: res.statusCode,
          error: hasFatalError ? `Servidor retornou erro HTTP ${res.statusCode}: ${body.slice(0, 350)}` : null,
          bodySnippet: body.slice(0, 200)
        });
      });
    });
    req.on('error', (err) => {
      resolve({ healthy: false, statusCode: null, error: `Falha ao conectar no servidor: ${err.message}` });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ healthy: false, statusCode: null, error: 'Tempo limite esgotado ao aguardar resposta do servidor.' });
    });
  });
}

/**
 * Executa código Python ou inicia um Servidor Python com instalação de bibliotecas
 */
async function runPythonCodeOrServer(code, options = {}) {
  const startTime = Date.now();
  let cleanCode = (code || '').trim();
  if (!cleanCode) {
    return { success: false, error: 'Nenhum código Python fornecido.' };
  }

  // Sanitização de quebras de linha caso venham escapadas como string literal
  if (cleanCode.includes('\\n') && cleanCode.split('\n').length <= 2) {
    cleanCode = cleanCode.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
  }

  // 1. Extração e Instalação Automática de Dependências
  const detectedModules = extractImports(cleanCode);
  let installedPackages = [];
  if (detectedModules.length > 0) {
    const installRes = await installMissingPackages(detectedModules);
    if (installRes.installed && installRes.installed.length > 0) {
      installedPackages = installRes.installed;
    }
  }

  const isServer = options.isServer !== undefined ? options.isServer : isWebServerCode(cleanCode);
  const appId = 'py_app_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  const appDir = path.join(APPS_DIR, appId);
  fs.mkdirSync(appDir, { recursive: true });
  const scriptPath = path.join(appDir, 'app.py');

  // Suporte automático a templates caso o código use render_template
  if (cleanCode.includes('render_template(')) {
    const templatesDir = path.join(appDir, 'templates');
    if (!fs.existsSync(templatesDir)) {
      try {
        fs.mkdirSync(templatesDir, { recursive: true });
        const defaultIndexHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Papaléguas App</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: rgba(30, 41, 59, 0.85); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 16px; padding: 32px; max-width: 540px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    h1 { color: #38bdf8; font-size: 24px; margin-bottom: 12px; }
    p { color: #94a3b8; font-size: 15px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 44px; margin-bottom: 12px;">⚡</div>
    <h1>Aplicação Flask em Execução!</h1>
    <p>Servidor ativo e renderizando com sucesso no Papaléguas Browser.</p>
  </div>
</body>
</html>`;
        fs.writeFileSync(path.join(templatesDir, 'index.html'), defaultIndexHtml, 'utf8');
      } catch (e) {}
    }
  }

  // 2. Se for uma Aplicação Web / Servidor
  if (isServer) {
    const port = options.port || await getFreePort(5001);
    
    // Identificação dos frameworks web
    const isFastApi = /\bfastapi\b/i.test(cleanCode) || /\bFastAPI\s*\(/i.test(cleanCode);
    const isFlask = /\bflask\b/i.test(cleanCode) || /\bFlask\s*\(/i.test(cleanCode);

    if (isFastApi) {
      if (cleanCode.includes('uvicorn.run(')) {
        cleanCode = cleanCode.replace(
          /uvicorn\.run\s*\([\s\S]*?\)/g,
          `uvicorn.run(app, host='0.0.0.0', port=${port})`
        );
      } else {
        const appVarMatch = cleanCode.match(/(\w+)\s*=\s*FastAPI\s*\(/);
        const appVarName = appVarMatch ? appVarMatch[1] : 'app';

        cleanCode += `\n\nif __name__ == '__main__':
    import uvicorn
    try:
        _routes = getattr(${appVarName}, 'routes', [])
        _has_root = any(getattr(r, 'path', None) == '/' for r in _routes)
        if not _has_root:
            from fastapi.responses import HTMLResponse
            @${appVarName}.get('/', response_class=HTMLResponse)
            def _papaleguas_home_auto_view():
                _items = "".join([f"<li style='margin:8px 0;'><b>{getattr(r, 'methods', '')}</b> <a href='{r.path}' style='color:#38bdf8;text-decoration:none;'>{r.path}</a></li>" for r in _routes if hasattr(r, 'path') and not r.path.startswith('/openapi')])
                return f"""<!DOCTYPE html><html lang='pt-BR'><head><meta charset='utf-8'><title>Papaleguas FastAPI</title><style>body{{font-family:system-ui,-apple-system,sans-serif;background:#0b0f19;color:#f8fafc;padding:30px;display:flex;justify-content:center;}} .card{{background:rgba(30,41,59,0.85);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:32px;max-width:580px;width:100%;box-shadow:0 20px 40px rgba(0,0,0,0.5);}} h1{{color:#38bdf8;font-size:22px;margin:0 0 12px;}} p{{color:#94a3b8;font-size:14px;line-height:1.6;}} .btn{{display:inline-block;background:#0284c7;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;}} ul{{background:#0f172a;padding:15px 25px;border-radius:8px;border:1px solid #334155;}} li{{margin:6px 0;}}</style></head><body><div class='card'><h1>⚡ API FastAPI em Execução!</h1><p>Sua API está ativa no Papaléguas Browser.</p><a href='docs' class='btn'>📖 Abrir Documentação Interativa Swagger (/docs)</a><h4 style='margin-top:16px;color:#94a3b8;'>Rotas Detectadas:</h4><ul>{_items}</ul></div></body></html>"""
    except Exception:
        pass
    uvicorn.run(${appVarName}, host='0.0.0.0', port=${port})
`;
      }
    } else if (isFlask) {
      const appVarMatch = cleanCode.match(/(\w+)\s*=\s*(?:flask\.)?Flask\s*\(/);
      const appVarName = appVarMatch ? appVarMatch[1] : 'app';
      const flaskRunRegex = new RegExp(`\\b${appVarName}\\.run\\s*\\([\\s\\S]*?\\)`, 'g');
      if (flaskRunRegex.test(cleanCode)) {
        cleanCode = cleanCode.replace(
          flaskRunRegex,
          `${appVarName}.run(host='0.0.0.0', port=${port}, debug=False)`
        );
      } else {
        cleanCode += `\n\nif __name__ == '__main__':\n    ${appVarName}.run(host='0.0.0.0', port=${port}, debug=False)\n`;
      }
    } else if (cleanCode.includes('SimpleHTTPRequestHandler') || cleanCode.includes('TCPServer') || cleanCode.includes('HTTPServer')) {
      cleanCode = cleanCode.replace(/PORT\s*=\s*\d+/g, `PORT = ${port}`);
      cleanCode = cleanCode.replace(/port\s*=\s*\d+/g, `port = ${port}`);
    }

    fs.writeFileSync(scriptPath, cleanCode, 'utf8');

    let logsStdout = '';
    let logsStderr = '';

    const env = {
      ...process.env,
      PORT: String(port),
      PYTHONUNBUFFERED: '1'
    };

    const pyProcess = spawn(PYTHON_CMD, [scriptPath], {
      cwd: appDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    pyProcess.stdout.on('data', (d) => {
      const str = d.toString();
      logsStdout += str;
      if (logsStdout.length > 50000) logsStdout = logsStdout.slice(-40000);
    });

    pyProcess.stderr.on('data', (d) => {
      const str = d.toString();
      logsStderr += str;
      if (logsStderr.length > 50000) logsStderr = logsStderr.slice(-40000);
    });

    // Registra o servidor ativo
    const serverUrl = `http://localhost:${port}`;
    const serverInfo = {
      appId,
      port,
      serverUrl,
      pid: pyProcess.pid,
      process: pyProcess,
      startTime: Date.now(),
      scriptPath,
      appDir,
      installedPackages,
      alive: true,
      getStdout: () => logsStdout,
      getStderr: () => logsStderr
    };

    activePythonServers.set(appId, serverInfo);

    pyProcess.on('close', (code) => {
      serverInfo.alive = false;
      serverInfo.exitCode = code;
      activePythonServers.delete(appId);
      recordServerHistory({
        appId,
        port,
        pid: pyProcess.pid,
        exitCode: code,
        closedAt: Date.now(),
        stdout: logsStdout.trim(),
        stderr: logsStderr.trim(),
        installedPackages
      });
      console.log(`[PYTHON SERVER] Servidor ${appId} (Porta ${port}) encerrado com código ${code}`);
    });

    // Aguarda o servidor levantar na porta (até 9 segundos)
    const portReady = await waitForPort(port, 9000);

    // Se a porta não abriu e o processo encerrou precocemente
    if (!portReady && !serverInfo.alive) {
      // Auto-cura: se faltar módulo, instala e reexecuta
      const missingMatch = logsStderr.match(/ModuleNotFoundError: No module named '([\w_]+)'/);
      if (missingMatch && missingMatch[1] && !options._retried) {
        const missingMod = missingMatch[1];
        console.log(`[PYTHON RUNNER] Detectado módulo faltante na inicialização: ${missingMod}. Instalando e reiniciando...`);
        await installMissingPackages([missingMod]);
        return runPythonCodeOrServer(code, { ...options, _retried: true, port });
      }

      return {
        success: false,
        isServer: true,
        appId,
        port,
        serverUrl,
        portReady: false,
        installedPackages,
        message: `O servidor Python encerrou antes de iniciar na porta ${port}.`,
        stdout: logsStdout.trim(),
        stderr: logsStderr.trim(),
        error: logsStderr.trim() || `O processo encerrou precocemente com código ${serverInfo.exitCode}.`,
        executionTimeMs: Date.now() - startTime
      };
    }

    return {
      success: true,
      isServer: true,
      appId,
      port,
      serverUrl,
      portReady,
      installedPackages,
      message: portReady
        ? `Servidor Python rodando com sucesso na porta ${port}!`
        : `Servidor Python iniciado (PID ${pyProcess.pid}). Aguardando conexões na porta ${port}...`,
      stdout: logsStdout.trim(),
      stderr: logsStderr.trim(),
      executionTimeMs: Date.now() - startTime
    };
  }

  // 3. Execução de Script Python Comum (Cálculos, Dados, Gráficos, CLI)
  // Suporte a gráficos Matplotlib: salva imagem para visualização direta se houver plt.show()
  let hasPlot = false;
  const plotPath = path.join(appDir, 'plot.png');
  if (cleanCode.includes('plt.show()') || cleanCode.includes('matplotlib')) {
    hasPlot = true;
    cleanCode = `
import matplotlib
matplotlib.use('Agg')
${cleanCode}
try:
    import matplotlib.pyplot as plt
    plt.savefig(r'${plotPath}', bbox_inches='tight', dpi=150)
except Exception:
    pass
`;
  }

  fs.writeFileSync(scriptPath, cleanCode, 'utf8');

  return new Promise((resolve) => {
    exec(`${PYTHON_CMD} "${scriptPath}"`, { timeout: 35000, maxBuffer: 1024 * 1024 * 4, cwd: appDir }, async (err, stdout, stderr) => {
      // Auto-cura: se falhou por módulo não encontrado, tenta instalar e rodar de novo
      if (err && stderr && stderr.includes('ModuleNotFoundError: No module named')) {
        const missingMatch = stderr.match(/No module named ['"]([^'"]+)['"]/);
        if (missingMatch && missingMatch[1]) {
          const missingMod = missingMatch[1];
          const pkg = KNOWN_MODULE_PACKAGES[missingMod] || missingMod;
          console.log(`[PYTHON RUNNER] Auto-cura ativada: instalando ${pkg}...`);
          const ins = await installMissingPackages([pkg]);
          if (ins.success) {
            // Reexecuta o script
            return resolve(runPythonCodeOrServer(code, options));
          }
        }
      }

      let plotBase64 = null;
      if (hasPlot && fs.existsSync(plotPath)) {
        try {
          plotBase64 = 'data:image/png;base64,' + fs.readFileSync(plotPath).toString('base64');
        } catch (e) {}
      }

      const executionTimeMs = Date.now() - startTime;
      if (err) {
        resolve({
          success: false,
          isServer: false,
          stdout: stdout ? stdout.trim() : '',
          stderr: stderr ? stderr.trim() : err.message,
          installedPackages,
          executionTimeMs
        });
      } else {
        resolve({
          success: true,
          isServer: false,
          stdout: stdout ? stdout.trim() : '(Código executado com sucesso sem saída no terminal)',
          stderr: stderr ? stderr.trim() : '',
          plotImage: plotBase64,
          installedPackages,
          executionTimeMs
        });
      }
    });
  });
}

/**
 * Encerra um servidor Python ativo
 */
function stopPythonServer(appIdOrPort) {
  for (const [id, s] of activePythonServers.entries()) {
    if (id === appIdOrPort || String(s.port) === String(appIdOrPort)) {
      try {
        s.process.kill('SIGTERM');
      } catch (e) {
        try { s.process.kill('SIGKILL'); } catch (err) {}
      }
      activePythonServers.delete(id);
      return { success: true, message: `Servidor na porta ${s.port} encerrado.` };
    }
  }
  return { success: false, message: 'Servidor não encontrado.' };
}

/**
 * Lista servidores ativos
 */
function listActivePythonServers() {
  const list = [];
  for (const [id, s] of activePythonServers.entries()) {
    list.push({
      appId: id,
      port: s.port,
      serverUrl: s.serverUrl,
      pid: s.pid,
      uptimeSeconds: Math.floor((Date.now() - s.startTime) / 1000),
      installedPackages: s.installedPackages
    });
  }
  return list;
}

/**
 * Finaliza todos os servidores e processos Python criados no Papaléguas,
 * liberando portas e eliminando processos órfãos do sistema.
 */
function wipePythonSessionFiles() {
  recentServersHistory.length = 0;
  try { stopAllPythonServers(); } catch (e) {}
  try {
    if (!fs.existsSync(APPS_DIR)) return { success: true };
    for (const name of fs.readdirSync(APPS_DIR)) {
      try { fs.rmSync(path.join(APPS_DIR, name), { recursive: true, force: true }); } catch (e) {}
    }
  } catch (e) {}
  return { success: true };
}

function stopAllPythonServers() {
  console.log('[PYTHON RUNNER] Limpando e finalizando todos os servidores Python do Papaléguas...');

  // 1. Finaliza os processos ativos mapeados
  for (const [id, s] of activePythonServers.entries()) {
    try {
      if (s.process && !s.process.killed) {
        s.process.kill('SIGTERM');
      }
    } catch (e) {}
  }
  activePythonServers.clear();

  // 2. Limpa processos órfãos no SO e libera as portas 5001 a 5030
  try {
    const { execSync } = require('child_process');
    execSync('pkill -9 -f "\\.papaleguas_python_apps" 2>/dev/null || true');
    execSync('fuser -k -9 5001/tcp 5002/tcp 5003/tcp 5004/tcp 5005/tcp 5006/tcp 5007/tcp 5008/tcp 5009/tcp 5010/tcp 2>/dev/null || true');
  } catch (e) {}

  console.log('[PYTHON RUNNER] Todos os serviços e servidores Python foram limpos com sucesso.');
  return { success: true, message: 'Todos os servidores Python foram finalizados com sucesso.' };
}

// Limpeza automática na inicialização (a cada reinício do servidor ou do app)
try {
  stopAllPythonServers();
} catch (e) {}

// Limpeza automática no encerramento do processo Node.js
process.on('exit', () => {
  stopAllPythonServers();
});
process.on('SIGINT', () => {
  stopAllPythonServers();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopAllPythonServers();
  process.exit(0);
});

module.exports = {
  runPythonCodeOrServer,
  stopPythonServer,
  stopAllPythonServers,
  wipePythonSessionFiles,
  listActivePythonServers,
  installMissingPackages,
  getServerLogs,
  verifyServerHealth
};
