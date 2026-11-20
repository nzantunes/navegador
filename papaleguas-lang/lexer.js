'use strict';

/**
 * Lexer da Linguagem Papaléguas (.ppl)
 * Tokeniza código-fonte .ppl preservando linha e coluna para diagnósticos precisos.
 */

const KEYWORDS = new Set([
  'fn', 'let', 'const', 'struct', 'enum', 'match', 'return', 'if', 'else', 'while', 'for', 'in',
  'break', 'continue',
  'true', 'false', 'and', 'or', 'not', 'export', 'policy',
  'u64', 'i64', 'f64', 'bool', 'str', 'void'
]);

const THREE_CHAR_OPS = new Set(['..=']);
const TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=', '->', '=>', '..', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=']);
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~']);
const PUNCTUATION = new Set(['(', ')', '{', '}', '[', ']', ',', ':', ';', '.', '@']);

function tokenize(source) {
  const src = String(source || '');
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      i += 1;
    }
  };

  while (i < src.length) {
    const ch = src[i];

    // Espaços em branco
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance(1);
      continue;
    }

    // Comentário de linha //
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') advance(1);
      continue;
    }

    // Comentário de bloco /* ... */
    if (ch === '/' && src[i + 1] === '*') {
      const startLine = line;
      const startCol = col;
      advance(2);
      let closed = false;
      while (i < src.length) {
        if (src[i] === '*' && src[i + 1] === '/') {
          advance(2);
          closed = true;
          break;
        }
        advance(1);
      }
      if (!closed) {
        throw new SyntaxError(`[Papaléguas Lexer] Comentário de bloco não fechado em ${startLine}:${startCol}`);
      }
      continue;
    }

    // Strings "..."
    if (ch === '"') {
      const startLine = line;
      const startCol = col;
      advance(1);
      let value = '';
      let closed = false;
      while (i < src.length) {
        const c = src[i];
        if (c === '"') {
          advance(1);
          closed = true;
          break;
        }
        if (c === '\\') {
          advance(1);
          if (i >= src.length) break;
          const esc = src[i];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else value += esc;
          advance(1);
          continue;
        }
        value += c;
        advance(1);
      }
      if (!closed) {
        throw new SyntaxError(`[Papaléguas Lexer] String não terminada em ${startLine}:${startCol}`);
      }
      tokens.push({ type: 'STRING', value, line: startLine, col: startCol });
      continue;
    }

    // Números (hex, binário, inteiros e decimais)
    if (ch >= '0' && ch <= '9') {
      const startLine = line;
      const startCol = col;
      if (ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        advance(2);
        let hexStr = '';
        while (i < src.length && (/[0-9a-fA-F]/.test(src[i]) || src[i] === '_')) {
          if (src[i] !== '_') hexStr += src[i];
          advance(1);
        }
        if (!hexStr) throw new SyntaxError(`[Papaléguas Lexer] Literal hexadecimal inválido em ${startLine}:${startCol}`);
        tokens.push({ type: 'INT', value: BigInt('0x' + hexStr).toString(), line: startLine, col: startCol });
        continue;
      }
      if (ch === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
        advance(2);
        let binStr = '';
        while (i < src.length && (src[i] === '0' || src[i] === '1' || src[i] === '_')) {
          if (src[i] !== '_') binStr += src[i];
          advance(1);
        }
        if (!binStr) throw new SyntaxError(`[Papaléguas Lexer] Literal binário inválido em ${startLine}:${startCol}`);
        tokens.push({ type: 'INT', value: BigInt('0b' + binStr).toString(), line: startLine, col: startCol });
        continue;
      }
      let numStr = '';
      let isFloat = false;
      while (i < src.length && ((src[i] >= '0' && src[i] <= '9') || src[i] === '_')) {
        if (src[i] !== '_') numStr += src[i];
        advance(1);
      }
      if (src[i] === '.' && src[i + 1] >= '0' && src[i + 1] <= '9') {
        isFloat = true;
        numStr += '.';
        advance(1);
        while (i < src.length && ((src[i] >= '0' && src[i] <= '9') || src[i] === '_')) {
          if (src[i] !== '_') numStr += src[i];
          advance(1);
        }
      }
      tokens.push({
        type: isFloat ? 'FLOAT' : 'INT',
        value: isFloat ? Number.parseFloat(numStr) : numStr,
        line: startLine,
        col: startCol
      });
      continue;
    }

    // Identificadores e palavras-chave
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      const startLine = line;
      const startCol = col;
      let ident = '';
      while (
        i < src.length &&
        ((src[i] >= 'a' && src[i] <= 'z') ||
          (src[i] >= 'A' && src[i] <= 'Z') ||
          (src[i] >= '0' && src[i] <= '9') ||
          src[i] === '_')
      ) {
        ident += src[i];
        advance(1);
      }
      tokens.push({
        type: KEYWORDS.has(ident) ? 'KEYWORD' : 'IDENT',
        value: ident,
        line: startLine,
        col: startCol
      });
      continue;
    }

    // Operadores de 3 caracteres
    const three = src.slice(i, i + 3);
    if (THREE_CHAR_OPS.has(three)) {
      tokens.push({ type: 'OP', value: three, line, col });
      advance(3);
      continue;
    }

    // Operadores de 2 caracteres
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ type: 'OP', value: two, line, col });
      advance(2);
      continue;
    }

    // Operadores de 1 caractere
    if (ONE_CHAR_OPS.has(ch)) {
      tokens.push({ type: 'OP', value: ch, line, col });
      advance(1);
      continue;
    }

    // Pontuação
    if (PUNCTUATION.has(ch)) {
      tokens.push({ type: 'PUNCT', value: ch, line, col });
      advance(1);
      continue;
    }

    throw new SyntaxError(`[Papaléguas Lexer] Caractere inválido '${ch}' em ${line}:${col}`);
  }

  tokens.push({ type: 'EOF', value: null, line, col });
  return tokens;
}

module.exports = { tokenize, KEYWORDS };
