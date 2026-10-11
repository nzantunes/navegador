import os
import sys
import time
import json
import subprocess
from flask import Flask, request, jsonify, send_from_directory, render_template_string

app = Flask(__name__)

DOWNLOADS_DIR = os.path.join(os.path.expanduser("~"), ".papaleguas_downloads")
os.makedirs(DOWNLOADS_DIR, exist_ok=True)

DOWNLOAD_HISTORY = []

@app.route("/api/convert", methods=["POST"])
def convert_video():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    fmt = (data.get("format") or "mp3").lower()

    if not url:
        return jsonify({"success": False, "error": "Por favor, forneça o link ou nome do vídeo do YouTube."}), 400

    # Se não for URL, pesquisa no YouTube
    if not (url.startswith("http://") or url.startswith("https://")):
        url = f"ytsearch1:{url}"

    file_id = f"yt_{int(time.time())}_{abs(hash(url)) % 10000}"
    output_template = os.path.join(DOWNLOADS_DIR, f"{file_id}.%(ext)s")

    cmd = [
        "yt-dlp",
        "--no-playlist",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", "0",
        "--output", output_template,
        "--print-json",
        "--no-warnings",
        url
    ] if fmt == "mp3" else [
        "yt-dlp",
        "--no-playlist",
        "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--output", output_template,
        "--print-json",
        "--no-warnings",
        url
    ]

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if res.returncode != 0:
            err = res.stderr or res.stdout
            return jsonify({"success": False, "error": f"Falha ao baixar do YouTube: {err[:250]}"}), 500

        info = {}
        for line in res.stdout.strip().split("\n"):
            try:
                info = json.loads(line)
                break
            except Exception:
                continue

        title = info.get("title") or "Audio_YouTube"
        duration = info.get("duration_string") or "--:--"
        thumb = info.get("thumbnail") or ""
        final_ext = "mp3" if fmt == "mp3" else "mp4"
        final_filename = f"{file_id}.{final_ext}"

        item = {
            "id": file_id,
            "title": title,
            "duration": duration,
            "thumbnail": thumb,
            "format": final_ext,
            "filename": final_filename,
            "url": f"downloads/{final_filename}",
            "timestamp": int(time.time())
        }
        DOWNLOAD_HISTORY.insert(0, item)
        return jsonify({"success": True, **item})
    except subprocess.TimeoutExpired:
        return jsonify({"success": False, "error": "Tempo limite excedido ao baixar vídeo (máximo 120s)."}), 504
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/downloads/<path:filename>")
def serve_download(filename):
    return send_from_directory(DOWNLOADS_DIR, filename, as_attachment=False)

@app.route("/api/history")
def get_history():
    return jsonify({"success": True, "history": DOWNLOAD_HISTORY[:15]})

PAGE_HTML = """
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Papaléguas YouTube MP3 Downloader</title>
  <style>
    :root {
      --bg: #07090e;
      --card: rgba(18, 25, 41, 0.85);
      --border: rgba(255,255,255,0.08);
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.3);
      --success: #10b981;
      --text: #f8fafc;
      --muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; padding: 28px 16px; display: flex; flex-direction: column; align-items: center; }
    .container { max-width: 680px; width: 100%; }
    header { text-align: center; margin-bottom: 28px; }
    .logo { font-size: 44px; margin-bottom: 8px; filter: drop-shadow(0 0 16px var(--accent-glow)); }
    h1 { font-size: 24px; font-weight: 800; color: #fff; display: flex; align-items: center; justify-content: center; gap: 10px; }
    p.subtitle { color: var(--muted); font-size: 14px; margin-top: 6px; }
    .box { background: var(--card); border: 1px solid var(--border); border-radius: 20px; padding: 26px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); backdrop-filter: blur(12px); margin-bottom: 24px; }
    .input-group { display: flex; flex-direction: column; gap: 14px; }
    input[type=text] { width: 100%; background: #0b0f19; border: 1px solid #334155; border-radius: 12px; padding: 14px 16px; color: #fff; font-size: 14px; outline: none; transition: 0.2s; }
    input[type=text]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2); }
    .format-options { display: flex; gap: 12px; }
    .radio-label { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; background: #0b0f19; border: 1px solid #334155; border-radius: 10px; padding: 12px; font-size: 13px; font-weight: 600; cursor: pointer; transition: 0.2s; }
    .radio-label:has(input:checked) { background: rgba(56, 189, 248, 0.15); border-color: var(--accent); color: var(--accent); }
    .btn-download { width: 100%; background: #0284c7; color: #fff; border: none; border-radius: 12px; padding: 14px; font-size: 15px; font-weight: 700; cursor: pointer; transition: 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 14px rgba(2, 132, 199, 0.4); }
    .btn-download:hover { background: #0369a1; transform: translateY(-1px); }
    .btn-download:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
    .status-card { display: none; background: #0b0f19; border: 1px solid var(--border); border-radius: 16px; padding: 20px; margin-top: 20px; animation: fadeIn 0.3s ease; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    .result-info { display: flex; gap: 16px; align-items: center; margin-bottom: 16px; }
    .thumb { width: 90px; height: 60px; object-fit: cover; border-radius: 8px; background: #1e293b; }
    .meta h3 { font-size: 15px; font-weight: 700; margin-bottom: 4px; color: #f1f5f9; }
    .meta p { font-size: 12px; color: var(--muted); }
    audio { width: 100%; margin-bottom: 14px; border-radius: 8px; outline: none; }
    .btn-save { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; background: var(--success); color: white; padding: 12px; border-radius: 10px; text-decoration: none; font-weight: bold; font-size: 14px; box-shadow: 0 4px 14px rgba(16, 185, 129, 0.4); }
    .btn-save:hover { background: #059669; }
    .history-section { margin-top: 10px; }
    .hist-title { font-size: 14px; font-weight: 700; color: var(--muted); margin-bottom: 12px; }
    .hist-item { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
    .spinner { display: inline-block; width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.3); border-radius: 50%; border-top-color: #fff; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo">🎵</div>
      <h1>Papaléguas YouTube MP3</h1>
      <p class="subtitle">Baixe e ouça áudios em MP3 de alta qualidade diretamente no navegador</p>
    </header>

    <div class="box">
      <div class="input-group">
        <input type="text" id="videoUrl" placeholder="Cole o link do YouTube (ou digite o nome da música/vídeo)..." value="https://www.youtube.com/watch?v=dQw4w9WgXcQ">
        <div class="format-options">
          <label class="radio-label"><input type="radio" name="fmt" value="mp3" checked> 🎵 Áudio MP3 (Alta Qualidade)</label>
          <label class="radio-label"><input type="radio" name="fmt" value="mp4"> 🎬 Vídeo MP4</label>
        </div>
        <button class="btn-download" id="convertBtn" onclick="startConvert()">
          <span id="btnText">⚡ Baixar & Converter para MP3</span>
        </button>
      </div>

      <div class="status-card" id="resultCard">
        <div class="result-info">
          <img id="resThumb" class="thumb" src="" alt="Thumbnail">
          <div class="meta">
            <h3 id="resTitle">Título da Faixa</h3>
            <p id="resMeta">Duração: 00:00 • Formato: MP3</p>
          </div>
        </div>
        <audio id="audioPlayer" controls></audio>
        <a id="saveLink" href="#" download class="btn-save">⬇️ Salvar Arquivo no Dispositivo</a>
      </div>
    </div>

    <div class="history-section" id="historySec" style="display:none;">
      <div class="hist-title">Downloads Recentes</div>
      <div id="historyList"></div>
    </div>
  </div>

  <script>
    async function startConvert() {
      const urlInput = document.getElementById('videoUrl');
      const btn = document.getElementById('convertBtn');
      const btnText = document.getElementById('btnText');
      const card = document.getElementById('resultCard');
      const fmt = document.querySelector('input[name="fmt"]:checked').value;
      const url = urlInput.value.trim();

      if (!url) {
        alert('Por favor, digite ou cole um link do YouTube.');
        return;
      }

      btn.disabled = true;
      btnText.innerHTML = '<span class="spinner"></span> Baixando e convertendo áudio...';
      card.style.display = 'none';

      try {
        const res = await fetch('api/convert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url, format: fmt })
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('resTitle').textContent = data.title;
          document.getElementById('resMeta').textContent = `Duração: ${data.duration} • Formato: ${data.format.toUpperCase()}`;
          if (data.thumbnail) document.getElementById('resThumb').src = data.thumbnail;
          
          const player = document.getElementById('audioPlayer');
          player.src = data.url;
          if (data.format === 'mp3') player.play().catch(() => {});

          const saveLink = document.getElementById('saveLink');
          saveLink.href = data.url;
          saveLink.download = `${data.title}.${data.format}`;
          saveLink.textContent = `⬇️ Salvar ${data.format.toUpperCase()} (${data.title.slice(0, 25)}...)`;

          card.style.display = 'block';
          loadHistory();
        } else {
          alert('Erro na conversão: ' + (data.error || 'Falha ao processar vídeo'));
        }
      } catch (e) {
        alert('Erro de conexão ao processar o vídeo.');
      } finally {
        btn.disabled = false;
        btnText.textContent = '⚡ Baixar & Converter para MP3';
      }
    }

    async function loadHistory() {
      try {
        const res = await fetch('api/history');
        const d = await res.json();
        if (d.success && d.history && d.history.length > 0) {
          document.getElementById('historySec').style.display = 'block';
          const list = document.getElementById('historyList');
          list.innerHTML = '';
          d.history.forEach(item => {
            const div = document.createElement('div');
            div.className = 'hist-item';
            div.innerHTML = `
              <div>
                <b style="font-size:13px;">${item.title.slice(0, 35)}...</b>
                <div style="font-size:11px;color:var(--muted);">${item.duration} • ${item.format.toUpperCase()}</div>
              </div>
              <a href="${item.url}" download="${item.title}.${item.format}" style="color:var(--accent);text-decoration:none;font-size:13px;font-weight:bold;">⬇️ Baixar</a>
            `;
            list.appendChild(div);
          });
        }
      } catch(e) {}
    }

    loadHistory();
  </script>
</body>
</html>
"""

@app.route("/")
def index():
    return render_template_string(PAGE_HTML)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=False)
