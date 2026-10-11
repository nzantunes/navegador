#!/usr/bin/env bash
# Script para iniciar o túnel externo com ngrok na porta 8080

PORT=8080
PROJECT_DIR="/home/nain/Área de trabalho/navegador"

cd "$PROJECT_DIR" || exit 1

NGROK_BIN="./bin/ngrok"

if [ ! -f "$NGROK_BIN" ]; then
    if command -v ngrok &> /dev/null; then
        NGROK_BIN="ngrok"
    else
        echo "❌ ngrok não foi encontrado em ./bin/ngrok nem no PATH."
        exit 1
    fi
fi

# Se passou token por argumento ou variável de ambiente, configura
DEFAULT_TOKEN="31VztvSOLZFjYqhrIl6lofps6AW_2oFjMCs3eFBropWS9Rppk"
TOKEN="${1:-${NGROK_AUTHTOKEN:-$DEFAULT_TOKEN}}"
if [ -n "$TOKEN" ]; then
    echo "🔑 Configurando authtoken do ngrok..."
    "$NGROK_BIN" config add-authtoken "$TOKEN"
fi

# Verifica se o authtoken está configurado
if ! "$NGROK_BIN" config check &> /dev/null; then
    echo "=================================================================="
    echo "⚠️  Authtoken do ngrok não configurado!"
    echo "O ngrok precisa de uma conta gratuita para liberar acesso externo."
    echo ""
    echo "1. Crie sua conta/pegue seu token em: https://dashboard.ngrok.com/get-started/your-authtoken"
    echo "2. Configure executando:"
    echo "   ./bin/ngrok config add-authtoken SEU_TOKEN_AQUI"
    echo "   ou execute:"
    echo "   ./start_ngrok.sh SEU_TOKEN_AQUI"
    echo "=================================================================="
    exit 1
fi

# Avisa se o servidor local não responder
if ! curl -s http://localhost:$PORT > /dev/null; then
    echo "ℹ️ Servidor local na porta $PORT não detectado ainda."
    echo "   Certifique-se de que a aplicação/servidor está em execução."
fi

echo "=========================================="
echo "🚀 Iniciando túnel ngrok na porta $PORT..."
echo "=========================================="

DOMAIN_FILE="$PROJECT_DIR/papaleguas/data/ngrok_domain.txt"
if [ -f "$DOMAIN_FILE" ]; then
    STORED_DOMAIN="$(cat "$DOMAIN_FILE" | tr -d '[:space:]')"
fi
DOMAIN="${NGROK_DOMAIN:-${STORED_DOMAIN:-papaleguas.ngrok.app}}"

if [ -n "$DOMAIN" ]; then
    echo "🌐 Tentando conectar com o domínio fixo: $DOMAIN"
    "$NGROK_BIN" http $PORT --url="$DOMAIN" || "$NGROK_BIN" http $PORT --domain="$DOMAIN" || {
        echo ""
        echo "⚠️  O domínio '$DOMAIN' ainda não foi registrado na sua conta do ngrok."
        echo "👉 Para ativá-lo gratuitamente, acesse: https://dashboard.ngrok.com/cloud-edge/domains"
        echo "   e clique em 'New Domain' ou 'Claim your free domain'."
        echo ""
        echo "🔄 Conectando com endereço automático..."
        "$NGROK_BIN" http $PORT
    }
else
    "$NGROK_BIN" http $PORT
fi
