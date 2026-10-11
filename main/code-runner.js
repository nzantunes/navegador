const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Executa código localmente (Python, Node.js ou Bash/Shell) de forma segura com timeout.
 * @param {string} language - 'python', 'javascript'/'node', 'bash'/'sh'
 * @param {string} code - Código a ser executado
 * @param {number} timeoutMs - Tempo limite em ms (padrão 15000ms)
 * @returns {Promise<{ success: boolean, stdout: string, stderr: string, error?: string, executionTimeMs: number }>}
 */
async function executeCode(language, code, timeoutMs = 15000) {
  const startTime = Date.now();
  const langNormalized = (language || '').toLowerCase().trim();

  // Diretório temporário para arquivos de execução
  const tempDir = path.join(os.tmpdir(), 'papaleguas_code');
  if (!fs.existsSync(tempDir)) {
    try {
      fs.mkdirSync(tempDir, { recursive: true });
    } catch (e) {
      // continua usando os.tmpdir() se falhar
    }
  }

  let command = '';
  let tempFilePath = '';
  const timestamp = Date.now() + '_' + Math.random().toString(36).substring(2, 7);

  if (langNormalized === 'python' || langNormalized === 'py' || langNormalized === 'python3') {
    const { runPythonCodeOrServer } = require('./python-runner');
    return await runPythonCodeOrServer(code, { timeout: timeoutMs });
  } else if (langNormalized === 'javascript' || langNormalized === 'js' || langNormalized === 'node') {
    tempFilePath = path.join(tempDir, `script_${timestamp}.js`);
    fs.writeFileSync(tempFilePath, code, 'utf8');
    command = `node "${tempFilePath}"`;
  } else if (langNormalized === 'bash' || langNormalized === 'sh' || langNormalized === 'shell') {
    tempFilePath = path.join(tempDir, `script_${timestamp}.sh`);
    fs.writeFileSync(tempFilePath, code, 'utf8');
    command = `bash "${tempFilePath}"`;
  } else {
    return {
      success: false,
      stdout: '',
      stderr: `Linguagem '${language}' não suportada para execução direta. Use 'python', 'javascript' ou 'bash'.`,
      executionTimeMs: 0
    };
  }

  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 2 }, (err, stdout, stderr) => {
      const executionTimeMs = Date.now() - startTime;

      // Limpar arquivo temporário
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (e) {}
      }

      if (err) {
        const isTimeout = err.killed || err.signal === 'SIGTERM';
        resolve({
          success: false,
          stdout: stdout ? stdout.trim() : '',
          stderr: isTimeout
            ? `Tempo limite de execução excedido (${timeoutMs / 1000}s). O processo foi encerrado.`
            : (stderr ? stderr.trim() : err.message),
          error: err.message,
          executionTimeMs
        });
      } else {
        resolve({
          success: true,
          stdout: stdout ? stdout.trim() : '(Executado com sucesso sem saída no terminal)',
          stderr: stderr ? stderr.trim() : '',
          executionTimeMs
        });
      }
    });
  });
}

module.exports = { executeCode };
