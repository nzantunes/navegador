# 🤖 Agente Autônomo de Melhoria de Código

Agente local que analisa arquivos do seu projeto, propõe refatorações, testa a sintaxe e valida automaticamente usando a API da OpenAI.

## 🚀 Como Executar

### 1. Modo Interativo
Basta rodar o script sem parâmetros:
```bash
python3 agent/code_agent.py
```
Ele listará os arquivos e pedirá o arquivo alvo e o que você deseja melhorar.

---

### 2. Linha de Comando (CLI Direto)
```bash
python3 agent/code_agent.py --file src/musica.js --goal "Adicionar tratamento de erros e tipagem JSDoc"
```

Usando o modelo mais leve e econômico (`gpt-4o-mini`):
```bash
python3 agent/code_agent.py --file src/musica.js --goal "Refatorar funções longas" --model gpt-4o-mini
```

---

## 🛡️ Mecanismos de Proteção Embutidos

1. **Validação Automática de Sintaxe (`node -c`)**:
   - Cada vez que o agente faz uma modificação, a ferramenta `run_code_validator` é executada para garantir que o JavaScript não quebrou sintaxe.
2. **Backup Preventivo Automático (`.agent_backups/`)**:
   - Antes de modificar qualquer linha, o agente gera uma cópia do arquivo original.
   - Se a validação final falhar após as tentativas do modelo, o agente **restaura o arquivo original** automaticamente.
3. **Sandboxing de Caminhos**:
   - Impede que o agente tente ler ou escrever arquivos fora da pasta do projeto.
