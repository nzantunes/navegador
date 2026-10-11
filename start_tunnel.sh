#!/usr/bin/env bash
# Script para iniciar a aplicação e criar uma nova conexão Cloudflare Tunnel

PORT=8080
PROJECT_DIR="/home/nain/Área de trabalho/navegador"

cd "$PROJECT_DIR" || exit 1

echo "=========================================="
echo "🚀 Criando nova conexão Cloudflare Tunnel"
echo "=========================================="

CLOUDFLARED_BIN="./bin/cloudflared"

if [ ! -f "$CLOUDFLARED_BIN" ]; then
    if command -v cloudflared &> /dev/null; then
        CLOUDFLARED_BIN="cloudflared"
    else
        echo "❌ cloudflared não foi encontrado."
        exit 1
    fi
fi

# 2. Inicia o servidor (e o túnel embutido) se a porta estiver livre
if ! curl -sf --max-time 2 "http://127.0.0.1:$PORT/" > /dev/null; then
    echo "▶️ Servidor local na porta $PORT não detectado. Iniciando a aplicação..."
    npm start &
    for i in $(seq 1 30); do
        if curl -sf --max-time 1 "http://127.0.0.1:$PORT/" > /dev/null; then
            break
        fi
        sleep 1
    done
fi

if pgrep -f "cloudflared.*tunnel" > /dev/null; then
    echo "✅ Túnel Cloudflare já foi iniciado junto com o servidor."
    exit 0
fi

# 3. Cria nova conexão Quick Tunnel se o app ainda não tiver ligado o cloudflared
echo "🔗 Criando nova conexão Cloudflare Tunnel..."
"$CLOUDFLARED_BIN" tunnel --no-autoupdate --no-prechecks --protocol http2 --edge-ip-version 4 --retries 15 --proxy-connect-timeout 30s --proxy-tcp-keepalive 30s --proxy-keepalive-timeout 90s --proxy-keepalive-connections 32 --url http://127.0.0.1:$PORT
