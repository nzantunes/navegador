#!/usr/bin/env bash
# ==============================================================================
# Papaléguas 24/7 Persistent Runner
# Mantém o Papaléguas ativo mesmo fechando a tampa do notebook.
# Reinicia automaticamente o servidor se travar ou cair.
# ==============================================================================

PROJECT_DIR="/home/nain/Área de trabalho/navegador"
PID_FILE="$PROJECT_DIR/papaleguas/data/supervisor.pid"
LOG_FILE="$PROJECT_DIR/papaleguas/data/supervisor.log"

cd "$PROJECT_DIR" || exit 1

# Garante permissões do GNOME para nunca suspender na tampa
apply_power_settings() {
    gsettings set org.gnome.settings-daemon.plugins.power lid-close-ac-action 'nothing' 2>/dev/null
    gsettings set org.gnome.settings-daemon.plugins.power lid-close-battery-action 'nothing' 2>/dev/null
    gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' 2>/dev/null
    gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type 'nothing' 2>/dev/null
}

start() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "✅ Papaléguas Supervisor já está em execução (PID: $PID)."
            exit 0
        fi
    fi

    apply_power_settings
    echo "🛡️  Proteção de tampa do notebook configurada (não suspende ao fechar)."
    echo "🚀 Iniciando o Supervisor 24/7 com auto-reinício..."

    mkdir -p "$(dirname "$PID_FILE")"

    # Inicia o supervisor completamente desacoplado da sessão de terminal (setsid)
    setsid node bin/papaleguas-watchdog.js </dev/null >> "$LOG_FILE" 2>&1 &


    sleep 1
    if [ -f "$PID_FILE" ]; then
        SUPERVISOR_PID=$(cat "$PID_FILE")
    else
        SUPERVISOR_PID=$!
    fi

    echo "✅ Papaléguas Supervisor ativo em segundo plano (PID: $SUPERVISOR_PID)."
    echo "📄 Logs em: $LOG_FILE"

    echo "📱 Conexões externas mantidas via Cloudflare e ngrok."
}

stop() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        echo "🛑 Parando o Supervisor (PID: $PID)..."
        kill "$PID" 2>/dev/null
        rm -f "$PID_FILE"
        fuser -k 8080/tcp 2>/dev/null
        pkill -f "electron --no-sandbox" 2>/dev/null
        echo "✅ Papaléguas e Supervisor finalizados."
    else
        echo "ℹ️ Nenhum supervisor em execução encontrado."
    fi
}

status() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "🟢 Supervisor está ATIVO (PID: $PID)."
        else
            echo "🔴 Supervisor parou (PID antigo: $PID)."
        fi
    else
        echo "⚪ Supervisor desligado."
    fi
    node bin/papaleguas-watchdog.js status
}

logs() {
    tail -n 40 -f "$LOG_FILE"
}

case "$1" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        stop
        sleep 2
        start
        ;;
    status)
        status
        ;;
    logs)
        logs
        ;;
    *)
        echo "Uso: $0 {start|stop|restart|status|logs}"
        echo "Executando start por padrão..."
        start
        ;;
esac
