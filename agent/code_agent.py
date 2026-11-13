#!/usr/bin/env python3
"""
Agente Autônomo de Refatoração e Melhoria de Código
Suporta: OpenAI, Google Gemini, Groq ou Ollama Local
Validação: Node.js (node -c), JSON Validator e Backup Preventivo
"""

import os
import sys
import json
import time
import shutil
import argparse
import subprocess
from pathlib import Path
from dotenv import load_dotenv

WORKSPACE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(WORKSPACE_DIR / ".env")

BACKUP_DIR = WORKSPACE_DIR / ".agent_backups"

class SessionState:
    def __init__(self, target_file: str):
        self.target_file = target_file
        self.modified = False
        self.valid_since_edit = False
        self.backup_path = None

session = None


# =====================================================================
# FERRAMENTAS DO AGENTE
# =====================================================================

def _safe_path(filepath: str) -> Path:
    target = (WORKSPACE_DIR / filepath).resolve()
    if not str(target).startswith(str(WORKSPACE_DIR)):
        raise ValueError(f"Acesso negado fora do workspace: {filepath}")
    return target


def read_file(filepath: str) -> str:
    """Lê o conteúdo completo de um arquivo do repositório."""
    try:
        path = _safe_path(filepath)
        if not path.exists():
            return f"Erro: Arquivo '{filepath}' não existe."
        return path.read_text(encoding="utf-8")
    except Exception as e:
        return f"Erro ao ler arquivo: {e}"


def write_file(filepath: str, content: str) -> str:
    """Escreve as melhorias no arquivo com backup automático preventivo."""
    global session
    try:
        path = _safe_path(filepath)
        
        # Backup preventivo na primeira escrita
        if path.exists() and (session is None or session.backup_path is None):
            BACKUP_DIR.mkdir(parents=True, exist_ok=True)
            backup_file = BACKUP_DIR / f"{path.name}.{int(time.time())}.bak"
            shutil.copy2(path, backup_file)
            if session:
                session.backup_path = backup_file

        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

        if session:
            session.modified = True
            session.valid_since_edit = False

        return (
            f"Sucesso: Arquivo '{filepath}' atualizado.\n"
            f"OBRIGATÓRIO: Execute run_code_validator('{filepath}') agora para validar sintaxe e erros."
        )
    except Exception as e:
        return f"Erro ao salvar arquivo: {e}"


def list_files(directory: str = "") -> str:
    """Lista arquivos e pastas em um diretório relativo do projeto."""
    try:
        target = _safe_path(directory) if directory else WORKSPACE_DIR
        if not target.exists() or not target.is_dir():
            return f"Erro: '{directory}' não é um diretório válido."
        
        items = []
        for p in sorted(target.iterdir()):
            if p.name.startswith((".", "node_modules", ".git", ".agent_backups")):
                continue
            suffix = "/" if p.is_dir() else ""
            items.append(f"{p.name}{suffix}")
        return "\n".join(items) if items else "(diretório vazio)"
    except Exception as e:
        return f"Erro ao listar diretório: {e}"


def run_code_validator(filepath: str = "") -> str:
    """Valida a sintaxe JS com `node -c`, validação JSON e checagem de erros."""
    global session
    target_rel = filepath or (session.target_file if session else "")
    if not target_rel:
        return "Erro: Nenhum arquivo especificado para validação."

    try:
        path = _safe_path(target_rel)
        if not path.exists():
            if session:
                session.valid_since_edit = False
            return f"Erro: Arquivo '{target_rel}' não existe para validação."

        logs = []
        is_ok = True

        if path.suffix in [".js", ".mjs", ".cjs"]:
            res = subprocess.run(
                ["node", "-c", str(path)],
                cwd=WORKSPACE_DIR,
                capture_output=True,
                text=True,
                timeout=15,
            )
            if res.returncode != 0:
                is_ok = False
                logs.append(f"[FALHA DE SINTAXE JS (node -c)]:\n{res.stderr or res.stdout}")
            else:
                logs.append(f"[OK] Sintaxe JavaScript válida em {target_rel}")

        elif path.suffix == ".json":
            try:
                json.loads(path.read_text(encoding="utf-8"))
                logs.append(f"[OK] Sintaxe JSON válida em {target_rel}")
            except json.JSONDecodeError as jde:
                is_ok = False
                logs.append(f"[FALHA DE SINTAXE JSON]: {jde}")

        if session:
            session.valid_since_edit = is_ok

        status_str = "VALIDAÇÃO: APROVADO (EXIT_CODE: 0)" if is_ok else "VALIDAÇÃO: REPROVADO (ERROS ENCONTRADOS)"
        return f"{status_str}\n" + "\n".join(logs)

    except subprocess.TimeoutExpired:
        if session:
            session.valid_since_edit = False
        return "Erro: Validação excedeu o tempo limite de 15 segundos."
    except Exception as e:
        if session:
            session.valid_since_edit = False
        return f"Erro ao executar validador: {e}"


# =====================================================================
# RUNNER OPENAI / GROQ
# =====================================================================

OPENAI_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Lê o conteúdo completo de um arquivo do projeto.",
            "parameters": {
                "type": "object",
                "properties": {"filepath": {"type": "string"}},
                "required": ["filepath"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Atualiza ou cria um arquivo com o código melhorado.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filepath": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["filepath", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_code_validator",
            "description": "Valida a sintaxe (node -c) e testes de um arquivo.",
            "parameters": {
                "type": "object",
                "properties": {"filepath": {"type": "string"}},
                "required": ["filepath"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "Lista pastas e arquivos do repositório.",
            "parameters": {
                "type": "object",
                "properties": {"directory": {"type": "string"}},
            },
        },
    },
]

TOOL_MAP = {
    "read_file": read_file,
    "write_file": write_file,
    "run_code_validator": run_code_validator,
    "list_files": list_files,
}

SYSTEM_PROMPT = """
Você é um Engenheiro de Software Sênior autônomo focado em melhorar, refatorar e blindar este código.
Regras:
1. Comece chamando `read_file` para analisar o arquivo alvo.
2. Faça melhorias pontuais sem quebrar contratos existentes.
3. Após cada chamada a `write_file`, você DEVE chamar `run_code_validator`.
4. Se `run_code_validator` acusar qualquer erro, corrija e revalide.
5. Só encerre quando o validador retornar EXIT_CODE: 0.
"""

def run_with_openai(api_key: str, target_file: str, goal: str, model: str = "gpt-4o", base_url: str = None, max_turns: int = 10):
    from openai import OpenAI
    client = OpenAI(api_key=api_key, base_url=base_url)

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"Arquivo alvo: {target_file}\nObjetivo: {goal}\nInicie inspecionando o arquivo.",
        },
    ]

    for turn in range(1, max_turns + 1):
        print(f"--- Turno {turn}/{max_turns} ---")
        try:
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                tools=OPENAI_TOOLS,
                tool_choice="auto",
                temperature=0.2,
            )
        except Exception as e:
            print(f"[!] Erro na chamada da API: {e}")
            break

        msg = response.choices[0].message
        messages.append(msg)

        if not msg.tool_calls:
            print(f"\n[+] Conclusão do Agente:\n{msg.content}")
            break

        for tool_call in msg.tool_calls:
            fn_name = tool_call.function.name
            try:
                fn_args = json.loads(tool_call.function.arguments)
            except Exception:
                fn_args = {}

            print(f"-> Executando: {fn_name}({fn_args})")
            fn = TOOL_MAP.get(fn_name)
            result = fn(**fn_args) if fn else f"Erro: Ferramenta '{fn_name}' não existe."

            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": str(result),
            })


# =====================================================================
# RUNNER GEMINI (google-genai)
# =====================================================================

def run_with_gemini(api_key: str, target_file: str, goal: str, model: str = "gemini-3.8-flash", max_turns: int = 10):
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)

    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        tools=[read_file, write_file, run_code_validator, list_files],
        temperature=0.2,
        automatic_function_calling=types.AutomaticFunctionCallingConfig(
            maximum_remote_calls=max_turns
        ),
    )

    prompt = (
        f"Arquivo alvo: {target_file}\n"
        f"Objetivo: {goal}\n\n"
        "Inicie inspecionando o arquivo alvo e execute a validação necessária."
    )

    for attempt in range(1, 4):
        try:
            print(f"[*] Conectando ao Gemini ({model})... (tentativa {attempt})")
            chat = client.chats.create(
                model=model,
                config=config,
            )
            response = chat.send_message(prompt)
            print(f"\n[+] Conclusão do Agente:\n{response.text}")
            break
        except Exception as e:
            err_str = str(e)
            if "503" in err_str and attempt < 3:
                print(f"[!] Pico de demanda temporário na API (503). Aguardando 5s...")
                time.sleep(5)
            elif "429" in err_str or "RESOURCE_EXHAUSTED" in err_str:
                import re
                match = re.search(r'retry in (\d+)', err_str)
                wait_sec = int(match.group(1)) if match else 60

                if "prepayment credits are depleted" in err_str or "402" in err_str:
                    print("\n[!] AVISO DE CONTA: Os créditos pré-pagos desta chave no Google AI Studio acabaram.")
                    print("[i] Você pode:")
                    print("    1. Criar uma nova chave em um projeto gratuito sem cartão em https://aistudio.google.com/app/apikey")
                    print("    2. Ou usar Groq grátis / OpenAI colocando GROQ_API_KEY ou OPENAI_API_KEY no seu .env")
                    break
                else:
                    print(f"\n[⏳ RATE LIMIT] Limite temporário da API atingido (5 requisições/minuto no Free Tier).")
                    print(f"[*] Aguardando {wait_sec}s para retentar automaticamente...")
                    for s in range(wait_sec, 0, -10):
                        print(f"    Restam {s}s...")
                        time.sleep(min(10, s))
                    print("[*] Retomando execução...")
            else:
                print(f"[!] Erro no Gemini: {e}")
                break


# =====================================================================
# PONTO DE ENTRADA E GERENCIAMENTO DE SESSÃO
# =====================================================================

def run_watch_mode():
    """Monitora o código em tempo real e avisa na hora se houver erros de sintaxe ao salvar."""
    print("\n=======================================================")
    print("[👁️ NZA WATCHER] Monitoramento em tempo real ativado!")
    print("[*] Observando arquivos em 'src/' e 'main/'...")
    print("[*] Toda vez que salvar um arquivo (Ctrl+S), a sintaxe será validada.")
    print("=======================================================\n")

    def get_tracked_files():
        tracked = []
        for d in ["src", "main", "papaleguas"]:
            p = WORKSPACE_DIR / d
            if p.exists():
                for f in p.rglob("*.js"):
                    tracked.append(f)
        return tracked

    last_mtimes = {f: f.stat().st_mtime for f in get_tracked_files() if f.exists()}

    try:
        while True:
            time.sleep(1)
            for f in get_tracked_files():
                try:
                    mtime = f.stat().st_mtime
                    if f not in last_mtimes or mtime > last_mtimes[f]:
                        last_mtimes[f] = mtime
                        rel_path = f.relative_to(WORKSPACE_DIR)
                        print(f"\n[⚡ SALVO] {rel_path} às {time.strftime('%H:%M:%S')}")
                        val = run_code_validator(str(rel_path))
                        if "APROVADO" in val:
                            print(f"   [✔] Sintaxe Node.js: OK")
                        else:
                            print(f"   [✘ ERRO DE SINTAXE]:\n{val}\n")
                except Exception:
                    pass
    except KeyboardInterrupt:
        print("\n[i] Monitoramento em tempo real encerrado.")


def main():
    global session

    parser = argparse.ArgumentParser(description="NZA - Agente Autônomo de Código")
    parser.add_argument("--watch", "-w", action="store_true", help="Monitorar arquivos em tempo real ao salvar")
    parser.add_argument("--file", "-f", help="Arquivo alvo (ex: src/musica.js)")
    parser.add_argument("--goal", "-g", help="Objetivo da tarefa")
    parser.add_argument("--provider", "-p", choices=["openai", "gemini", "groq", "ollama"], help="Provedor de LLM")
    parser.add_argument("--model", "-m", help="Nome do modelo")
    args = parser.parse_args()

    if args.watch:
        run_watch_mode()
        return

    # Identifica provedor disponível
    openai_key = os.getenv("OPENAI_API_KEY")
    gemini_key = os.getenv("GEMINI_API_KEY")
    groq_key = os.getenv("GROQ_API_KEY")

    provider = args.provider
    if not provider:
        if openai_key:
            provider = "openai"
        elif gemini_key:
            provider = "gemini"
        elif groq_key:
            provider = "groq"
        else:
            provider = "ollama"

    target_file = args.file
    goal = args.goal

    if not target_file:
        print("\n=== AGENTE AUTÔNOMO DE CÓDIGO ===")
        print("Arquivos do projeto em 'src/':")
        print(list_files("src"))
        print("---------------------------------")
        target_file = input("Arquivo alvo (ex: src/musica.js): ").strip()

    if not goal:
        goal = input("Objetivo da melhoria: ").strip()

    if not target_file or not goal:
        print("Erro: Arquivo e objetivo são obrigatórios.")
        sys.exit(1)

    session = SessionState(target_file)
    print(f"\n[*] Provedor selecionado: {provider.upper()}")
    print(f"[*] Alvo: {target_file}")
    print(f"[*] Meta: {goal}\n")

    if provider == "gemini":
        if not gemini_key:
            print("Erro: GEMINI_API_KEY não configurada no .env")
            sys.exit(1)
        model = args.model or "gemini-3.8-flash"
        run_with_gemini(gemini_key, target_file, goal, model=model)

    elif provider == "groq":
        if not groq_key:
            print("Erro: GROQ_API_KEY não configurada no .env")
            sys.exit(1)
        model = args.model or "llama-3.3-70b-versatile"
        run_with_openai(groq_key, target_file, goal, model=model, base_url="https://api.groq.com/openai/v1")

    elif provider == "ollama":
        model = args.model or "llama3.2"
        run_with_openai("ollama", target_file, goal, model=model, base_url="http://localhost:11434/v1")

    else:  # openai
        if not openai_key:
            print("Erro: OPENAI_API_KEY não configurada no .env")
            sys.exit(1)
        model = args.model or "gpt-4o-mini"
        run_with_openai(openai_key, target_file, goal, model=model)

    # Verificação pós-execução e segurança
    print("\n-------------------------------------------------------")
    if session.modified and session.valid_since_edit:
        print(f"[✔ SUCESSO] Arquivo '{target_file}' melhorado e aprovado pelo validador!")
        if session.backup_path:
            print(f"[i] Backup de segurança salvo em: {session.backup_path}")
    elif session.modified and not session.valid_since_edit:
        print(f"[✘ ATENÇÃO] Validação falhou! Restaurando backup preventivo...")
        if session.backup_path and session.backup_path.exists():
            shutil.copy2(session.backup_path, _safe_path(target_file))
            print("[✔] Código original restaurado com segurança.")
    else:
        print("[i] Sessão concluída sem alterações nos arquivos.")
    print("-------------------------------------------------------\n")


if __name__ == "__main__":
    main()
