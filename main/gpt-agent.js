const { net } = require('electron');
const querystring = require('querystring');
const { executeCode } = require('./code-runner');
const aiClient = require('./ai-client');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "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";
aiClient.setOpenAiFallbackKey(OPENAI_API_KEY);

// Busca cotações de moedas e mercado financeiro em tempo real
async function fetchFinanceData(torSession) {
  return new Promise((resolve) => {
    const req = net.request({
      url: "https://economia.awesomeapi.com.br/last/USD-BRL,EUR-BRL,BTC-BRL",
      session: torSession
    });

    let data = '';
    req.on('response', (res) => {
      res.on('data', chunk => data += chunk.toString());
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const usd = parsed.USDBRL;
          const eur = parsed.EURBRL;
          const btc = parsed.BTCBRL;
          const text = `DADOS FINANCEIROS EXATOS EM TEMPO REAL AGORA:
• Dólar Comercial (USD/BRL): R$ ${Number(usd.bid).toFixed(2)} (Compra: R$ ${Number(usd.bid).toFixed(2)}, Venda: R$ ${Number(usd.ask).toFixed(2)}, Máxima do dia: R$ ${Number(usd.high).toFixed(2)}, Mínima: R$ ${Number(usd.low).toFixed(2)})
• Euro (EUR/BRL): R$ ${Number(eur.bid).toFixed(2)}
• Bitcoin (BTC/BRL): R$ ${Number(btc.bid).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
Data e hora da cotação: ${usd.create_date}`;
          resolve(text);
        } catch (e) {
          resolve('');
        }
      });
    });

    req.on('error', () => resolve(''));
    req.end();
  });
}

// Busca na Web via POST seguro para extrair links e snippets
async function searchTheWeb(query, torSession) {
  return new Promise((resolve) => {
    const postData = querystring.stringify({ q: query });
    const req = net.request({
      method: 'POST',
      url: 'https://html.duckduckgo.com/html/',
      session: torSession
    });

    req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
    req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    let html = '';
    req.on('response', (res) => {
      res.on('data', chunk => html += chunk.toString());
      res.on('end', () => {
        try {
          const links = [];
          const snippets = [];
          const linkRegex = /<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>/g;
          const snipRegex = /<a class="result__snippet"[^"]*href="[^"]*">([\s\S]*?)<\/a>/g;

          let m;
          while ((m = linkRegex.exec(html)) !== null) {
            let u = m[1];
            const uddg = /uddg=([^&]+)/.exec(u);
            if (uddg) u = decodeURIComponent(uddg[1]);
            links.push({
              title: m[2].replace(/<[^>]+>/g, '').trim(),
              url: u
            });
          }

          while ((m = snipRegex.exec(html)) !== null) {
            snippets.push(m[1].replace(/<[^>]+>/g, '').trim());
          }

          const results = [];
          const total = Math.min(links.length, snippets.length, 10);
          for (let i = 0; i < total; i++) {
            results.push({
              title: links[i].title,
              url: links[i].url,
              snippet: snippets[i]
            });
          }
          resolve(results);
        } catch (e) {
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.write(postData);
    req.end();
  });
}

function callOpenAiChat(payload) {
  return aiClient.callMainAi(payload);
}

// Execução principal com IA + Navegação em tempo real + Capacidade de Execução de Código
async function runGptNavigator(userPromptOrMessages, torSession) {
  let userPrompt = "";
  let previousMessages = [];

  if (Array.isArray(userPromptOrMessages)) {
    previousMessages = userPromptOrMessages.slice(0, -1);
    const lastMsg = userPromptOrMessages[userPromptOrMessages.length - 1];
    userPrompt = lastMsg ? (lastMsg.content || lastMsg) : "";
  } else if (typeof userPromptOrMessages === 'object' && userPromptOrMessages !== null && userPromptOrMessages.prompt) {
    userPrompt = userPromptOrMessages.prompt;
    previousMessages = Array.isArray(userPromptOrMessages.history) ? userPromptOrMessages.history : [];
  } else {
    userPrompt = String(userPromptOrMessages || "");
  }

  const isFinance = /dolar|dólar|euro|bitcoin|moeda|cotação|cotacao|câmbio|cambio|real/i.test(userPrompt);
  const isCodeExecutionPrompt = /execut|rode|roda|rodar|execute|terminal|bash|python|script|calcule|código|codigo/i.test(userPrompt);

  let financeInfo = "";
  if (isFinance) {
    try {
      financeInfo = await fetchFinanceData(torSession);
    } catch (e) {}
  }

  let webResults = [];
  // Sempre busca na web exceto se for puramente script local sem necessidade de dados externos
  if (!isCodeExecutionPrompt || /notícia|noticia|quem|onde|quando|site|link|como|preço|preco|atual|hoje|governo|brasil|mundo/i.test(userPrompt) || userPrompt.split(" ").length < 6) {
    try {
      webResults = await searchTheWeb(userPrompt, torSession);
    } catch (err) {
      console.log("Aviso de busca:", err.message);
    }
  }

  let webContext = "";
  if (financeInfo) {
    webContext += financeInfo + "\n\n";
  }

  if (webResults && webResults.length > 0) {
    webContext += "INFORMAÇÕES E DADOS EXTRAÍDOS DA INTERNET EM TEMPO REAL:\n" +
      webResults.map((r, i) => `[FONTE ${i+1}] ${r.title}\nURL: ${r.url}\nCONTEÚDO EXTRAÍDO: ${r.snippet}`).join("\n\n");
  }

  const systemInstructions = `Você é o Papaléguas AI, com Grok (xAI) como agente principal: assistente autônomo com navegação profunda e em tempo real do Papaléguas Tor Browser.
Estamos no ano de 2026. Considere 2026 como o presente atual e contemporâneo para todas as pesquisas, notícias, lançamentos, músicas em alta e cotações.

DIRETRIZES FUNDAMENTAIS PARA RESPOSTAS COM DADOS DA INTERNET:
1. PROFUNDIDADE E RIQUEZA DE INFORMAÇÕES:
   - Quando o usuário perguntar sobre qualquer assunto, notícia, fato, cotação, tecnologia ou tutorial, NÃO DÊ RESPOSTAS CURTAS OU GENÉRICAS.
   - Analise e sintetize TODAS as informações, fatos, números, datas e contextos extraídos das fontes da internet fornecidas no prompt.
   - Estruture sua resposta de maneira completa:
     • **Resumo Executivo / Resposta Direta**: o panorama principal imediato.
     • **Detalhes Aprofundados**: números, dados históricos, acontecimentos recentes e perspectivas.
     • **Principais Fontes e Referências**: liste as fontes consultadas com seus links Markdown clicáveis [Título do Artigo/Site](URL) acompanhados de uma breve explicação do que cada fonte informa.

2. EXECUÇÃO VISUAL / 3D INTERATIVA NO NAVEGADOR ("execute aqui", 3D, Three.js, Canvas, Animações, Jogos, HTML/CSS/JS):
   - Forneça bloco completo em \`\`\`html ... \`\`\` funcional e autocontido (Three.js CDN, iluminação, animação) para renderizar na tela.

3. EXECUÇÃO DE TERMINAL E SERVIDORES PYTHON (Python, Node.js, Bash):
   - Use a ferramenta 'execute_code' para rodar e retornar a saída real.
   - Para Python, bibliotecas necessárias são instaladas AUTOMATICAMENTE via pip pelo Papaléguas.
   - Sempre que o usuário pedir para criar ou testar uma aplicação, scanner, painel ou automação, construa como servidor web em Flask com HTML/CSS embutido moderno, para que a aplicação seja exibida funcionando no navegador.
   - NUNCA use bibliotecas que exigem root/sudo (como Scapy sniff ou raw sockets). Para tarefas de rede/wifi no Linux, utilize comandos não-privilegiados como 'nmcli dev wifi' via subprocess.
   - Se o código Python for uma aplicação web ou servidor (Flask, FastAPI, etc.), a ferramenta iniciará o servidor e retornará a porta e o link. Você DEVE fornecer ao usuário na resposta o link clicável Markdown: [🚀 Abrir Aplicação Python](/python-app?port=PORTA) ou [🔗 Acesso Direto](/python-proxy/PORTA/). NUNCA use 'localhost'.

4. FORMATO DE LINKS:
   - Toda URL ou fonte DEVE ser formatada como link Markdown clicável: [Nome da Fonte](URL).`;

  const tools = [
    {
      type: "function",
      function: {
        name: "execute_code",
        description: "Executa código localmente no computador usando Python3, Node.js ou Bash, instalando automaticamente qualquer biblioteca necessária via pip (ex: Flask, Requests, NumPy, Pandas, FastAPI, etc.). Se for um servidor ou API web em Python, inicia o servidor e retorna o link e a porta para visualização ao vivo no Papaléguas Browser.",
        parameters: {
          type: "object",
          properties: {
            language: {
              type: "string",
              enum: ["python", "javascript", "bash"],
              description: "Linguagem de programação: 'python', 'javascript' (Node.js) ou 'bash' (Shell)."
            },
            code: {
              type: "string",
              description: "Código fonte completo pronto para ser executado."
            }
          },
          required: ["language", "code"]
        }
      }
    }
  ];

  let promptContent = `Pergunta / Pedido do usuário: "${userPrompt}"`;
  if (webContext.trim()) {
    promptContent += `\n\n${webContext}\n\nINSTRUÇÃO: Utilize o máximo de detalhes e dados extraídos acima para fornecer uma resposta rica, aprofundada e completa, com todas as fontes citadas como links clicáveis.`;
  } else if (isCodeExecutionPrompt) {
    promptContent += `\n\nO usuário deseja execução de código. Se for visual/3D/HTML/Three.js/Canvas, entregue o código HTML completo autocontido com Three.js CDN para execução imediata no navegador. Se for script Python/Node/Bash ou cálculo, chame a ferramenta 'execute_code'.`;
  }

  const messages = [
    { role: "system", content: systemInstructions }
  ];

  // Injeta histórico anterior se houver
  if (Array.isArray(previousMessages) && previousMessages.length > 0) {
    for (const msg of previousMessages) {
      if (msg && msg.role && msg.content) {
        messages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: String(msg.content)
        });
      }
    }
  }

  messages.push({ role: "user", content: promptContent });

  try {
    // 1ª Chamada à OpenAI com suporte a ferramentas
    const firstResponse = await callOpenAiChat({
      model: "gpt-4o",
      messages: messages,
      tools: tools,
      tool_choice: "auto",
      temperature: 0.2
    }, torSession);

    if (firstResponse.error) {
      return `Erro na API Grok: ${firstResponse.error.message}`;
    }

    const choice = firstResponse.choices && firstResponse.choices[0];
    if (!choice) {
      return 'Não foi possível gerar a resposta.';
    }

    const assistantMessage = choice.message;

    // Se o modelo decidiu chamar uma ou mais ferramentas de execução de código
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      messages.push(assistantMessage);

      for (const toolCall of assistantMessage.tool_calls) {
        if (toolCall.function && toolCall.function.name === "execute_code") {
          let args = {};
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch (e) {
            args = { language: "python", code: toolCall.function.arguments };
          }

          console.log(`[Papaléguas AI] Executando código (${args.language})...`);
          const execResult = await executeCode(args.language, args.code, 15000);
          console.log(`[Papaléguas AI] Execução concluída em ${execResult.executionTimeMs}ms (Sucesso: ${execResult.success})`);

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              success: execResult.success,
              is_server: execResult.isServer || false,
              port: execResult.port || null,
              server_url: execResult.serverUrl || null,
              proxy_url: execResult.port ? `/python-proxy/${execResult.port}/` : null,
              app_viewer_url: execResult.port ? `/python-app?port=${execResult.port}` : null,
              installed_packages: execResult.installedPackages || [],
              stdout: execResult.stdout,
              stderr: execResult.stderr,
              execution_time_ms: execResult.executionTimeMs
            })
          });
        }
      }

      // 2ª Chamada para o GPT formatar a resposta final com o resultado do código executado
      const secondResponse = await callOpenAiChat({
        model: "gpt-4o",
        messages: messages,
        temperature: 0.2
      }, torSession);

      if (secondResponse.error) {
        return `Erro na conclusão da execução: ${secondResponse.error.message}`;
      }

      if (secondResponse.choices && secondResponse.choices[0]) {
        return secondResponse.choices[0].message.content;
      }
    }

    // Se não chamou ferramenta, retorna o conteúdo normal gerado
    return assistantMessage.content || 'Sem resposta disponível.';
  } catch (err) {
    return `Erro ao consultar Papaléguas AI: ${err.message}`;
  }
}

module.exports = { runGptNavigator, callOpenAiChat };
