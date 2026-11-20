'use strict';

/**
 * Parser da Linguagem Papaléguas (.ppl)
 * Constrói uma AST tipada e estruturada a partir dos tokens do lexer.
 */

const TYPE_KEYWORDS = new Set(['u64', 'i64', 'f64', 'bool', 'str', 'void']);

function parse(tokens) {
  let pos = 0;

  const peek = (offset = 0) => tokens[pos + offset] || { type: 'EOF', value: null, line: 0, col: 0 };
  const next = () => tokens[pos++];

  const expect = (type, value) => {
    const tok = peek();
    if (tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new SyntaxError(
        `[Papaléguas Parser] Esperado ${type}${value !== undefined ? ` '${value}'` : ''}, encontrado ${tok.type} '${tok.value}' em ${tok.line}:${tok.col}`
      );
    }
    return next();
  };

  const match = (type, value) => {
    const tok = peek();
    if (tok.type === type && (value === undefined || tok.value === value)) {
      return next();
    }
    return null;
  };

  function parseType() {
    const tok = peek();
    if (tok.type === 'PUNCT' && tok.value === '[') {
      next();
      const sizeTok = expect('INT');
      const size = Number(sizeTok.value);
      if (!Number.isInteger(size) || size <= 0) {
        throw new SyntaxError(`[Papaléguas Parser] Tamanho de array inválido '${sizeTok.value}' em ${sizeTok.line}:${sizeTok.col}`);
      }
      expect('PUNCT', ']');
      const elemType = parseType();
      return `[${size}]${elemType}`;
    }
    if (tok.type === 'KEYWORD' && TYPE_KEYWORDS.has(tok.value)) {
      return next().value;
    }
    if (tok.type === 'IDENT') {
      return next().value;
    }
    throw new SyntaxError(`[Papaléguas Parser] Tipo inválido '${tok.value}' em ${tok.line}:${tok.col}`);
  }

  function parsePolicyAnnotation() {
    const atTok = expect('PUNCT', '@');
    const kw = expect('KEYWORD', 'policy');
    expect('PUNCT', '(');
    const rules = {};
    while (peek().type !== 'PUNCT' || peek().value !== ')') {
      const keyTok = expect('IDENT');
      expect('OP', '=');
      const valTok = peek();
      let val;
      if (valTok.type === 'INT') val = Number(next().value);
      else if (valTok.type === 'FLOAT') val = next().value;
      else if (valTok.type === 'STRING') val = next().value;
      else if (valTok.type === 'KEYWORD' && (valTok.value === 'true' || valTok.value === 'false')) {
        val = next().value === 'true';
      } else {
        throw new SyntaxError(`[Papaléguas Parser] Valor inválido em @policy em ${valTok.line}:${valTok.col}`);
      }
      rules[keyTok.value] = val;
      if (!match('PUNCT', ',')) break;
    }
    expect('PUNCT', ')');
    return { type: 'Policy', rules, line: atTok.line, col: atTok.col || kw.col };
  }

  function parseProgram() {
    const policies = [];
    const structs = [];
    const enums = [];
    const consts = [];
    const functions = [];

    while (peek().type !== 'EOF') {
      if (peek().type === 'PUNCT' && peek().value === '@') {
        const pol = parsePolicyAnnotation();
        if (peek().type === 'KEYWORD' && (peek().value === 'fn' || peek().value === 'export')) {
          const fnNode = parseFunction(pol);
          functions.push(fnNode);
        } else {
          policies.push(pol);
        }
        continue;
      }
      if (peek().type === 'KEYWORD' && peek().value === 'struct') {
        structs.push(parseStructDecl());
        continue;
      }
      if (peek().type === 'KEYWORD' && peek().value === 'enum') {
        enums.push(parseEnumDecl());
        continue;
      }
      if (peek().type === 'KEYWORD' && peek().value === 'const') {
        consts.push(parseConstDecl());
        continue;
      }
      if (peek().type === 'KEYWORD' && (peek().value === 'fn' || peek().value === 'export')) {
        functions.push(parseFunction(null));
        continue;
      }
      const tok = peek();
      throw new SyntaxError(`[Papaléguas Parser] Declaração inesperada '${tok.value}' em ${tok.line}:${tok.col}`);
    }

    return { type: 'Program', policies, structs, enums, consts, functions };
  }

  function parseEnumDecl() {
    const kw = expect('KEYWORD', 'enum');
    const name = expect('IDENT').value;
    expect('PUNCT', '{');
    const variants = [];
    let nextVal = 0;
    while (peek().type !== 'PUNCT' || peek().value !== '}') {
      const vName = expect('IDENT').value;
      let val = nextVal;
      if (match('OP', '=')) {
        const numTok = expect('INT');
        val = Number(numTok.value);
      }
      variants.push({ name: vName, value: val });
      nextVal = val + 1;
      if (!match('PUNCT', ',')) {
        match('PUNCT', ';');
        if (peek().type === 'PUNCT' && peek().value === '}') break;
      }
    }
    expect('PUNCT', '}');
    return { type: 'EnumDecl', name, variants, line: kw.line, col: kw.col };
  }

  function parseStructDecl() {
    const kw = expect('KEYWORD', 'struct');
    const name = expect('IDENT').value;
    expect('PUNCT', '{');
    const fields = [];
    while (peek().type !== 'PUNCT' || peek().value !== '}') {
      const fName = expect('IDENT').value;
      expect('PUNCT', ':');
      const fType = parseType();
      fields.push({ name: fName, fieldType: fType });
      if (!match('PUNCT', ',')) {
        match('PUNCT', ';');
        if (peek().type === 'PUNCT' && peek().value === '}') break;
      }
    }
    expect('PUNCT', '}');
    return { type: 'StructDecl', name, fields, line: kw.line, col: kw.col };
  }

  function parseConstDecl() {
    const kw = expect('KEYWORD', 'const');
    const name = expect('IDENT').value;
    expect('PUNCT', ':');
    const varType = parseType();
    expect('OP', '=');
    const init = parseExpr();
    match('PUNCT', ';');
    return { type: 'ConstDecl', name, varType, init, line: kw.line, col: kw.col };
  }

  function parseFunction(policy) {
    const isExport = Boolean(match('KEYWORD', 'export'));
    const fnTok = expect('KEYWORD', 'fn');
    const name = expect('IDENT').value;
    expect('PUNCT', '(');
    const params = [];
    while (peek().type !== 'PUNCT' || peek().value !== ')') {
      const pName = expect('IDENT').value;
      expect('PUNCT', ':');
      const pType = parseType();
      params.push({ name: pName, paramType: pType });
      if (!match('PUNCT', ',')) break;
    }
    expect('PUNCT', ')');
    let returnType = 'void';
    if (match('OP', '->')) {
      returnType = parseType();
    }
    const body = parseBlock();
    return {
      type: 'FnDecl',
      name,
      isExport,
      params,
      returnType,
      policy: policy ? policy.rules : null,
      body,
      line: fnTok.line,
      col: fnTok.col
    };
  }

  function parseBlock() {
    const open = expect('PUNCT', '{');
    const stmts = [];
    while (peek().type !== 'PUNCT' || peek().value !== '}') {
      if (peek().type === 'EOF') {
        throw new SyntaxError(`[Papaléguas Parser] Bloco '{' iniciado em ${open.line}:${open.col} não foi fechado`);
      }
      stmts.push(parseStmt());
    }
    expect('PUNCT', '}');
    return { type: 'Block', stmts, line: open.line, col: open.col };
  }

  function parseStmt() {
    const tok = peek();
    if (tok.type === 'KEYWORD' && tok.value === 'let') {
      next();
      const name = expect('IDENT').value;
      let varType = null;
      if (match('PUNCT', ':')) {
        varType = parseType();
      }
      expect('OP', '=');
      const init = parseExpr();
      match('PUNCT', ';');
      return { type: 'LetStmt', name, varType, init, line: tok.line, col: tok.col };
    }

    if (tok.type === 'KEYWORD' && tok.value === 'return') {
      next();
      let value = null;
      if (!(peek().type === 'PUNCT' && (peek().value === ';' || peek().value === '}'))) {
        value = parseExpr();
      }
      match('PUNCT', ';');
      return { type: 'ReturnStmt', value, line: tok.line, col: tok.col };
    }

    if (tok.type === 'KEYWORD' && tok.value === 'if') {
      next();
      const test = parseExpr();
      const consequent = parseBlock();
      let alternate = null;
      if (match('KEYWORD', 'else')) {
        if (peek().type === 'KEYWORD' && peek().value === 'if') {
          alternate = parseStmt();
        } else {
          alternate = parseBlock();
        }
      }
      return { type: 'IfStmt', test, consequent, alternate, line: tok.line, col: tok.col };
    }

    if (tok.type === 'KEYWORD' && tok.value === 'while') {
      next();
      const test = parseExpr();
      const body = parseBlock();
      return { type: 'WhileStmt', test, body, line: tok.line, col: tok.col };
    }

    if (tok.type === 'KEYWORD' && tok.value === 'for') {
      next();
      const iter = expect('IDENT').value;
      expect('KEYWORD', 'in');
      const start = parseExpr();
      let inclusive = false;
      if (match('OP', '..=')) {
        inclusive = true;
      } else {
        expect('OP', '..');
      }
      const end = parseExpr();
      const body = parseBlock();
      return { type: 'ForStmt', iter, start, end, inclusive, body, line: tok.line, col: tok.col };
    }

    if (tok.type === 'KEYWORD' && tok.value === 'match') {
      next();
      const subject = parseExpr();
      expect('PUNCT', '{');
      const arms = [];
      while (peek().type !== 'PUNCT' || peek().value !== '}') {
        if (peek().type === 'EOF') {
          throw new SyntaxError(`[Papaléguas Parser] Bloco 'match' iniciado em ${tok.line}:${tok.col} não foi fechado`);
        }
        const patterns = [];
        let isWildcard = false;
        while (true) {
          if (peek().type === 'IDENT' && peek().value === '_') {
            next();
            isWildcard = true;
          } else {
            patterns.push(parseUnary());
          }
          if (!match('OP', '|')) break;
        }
        expect('OP', '=>');
        const body = parseBlock();
        arms.push({ patterns, isWildcard, body });
        match('PUNCT', ',');
      }
      expect('PUNCT', '}');
      return { type: 'MatchStmt', subject, arms, line: tok.line, col: tok.col };
    }

    if (tok.type === 'KEYWORD' && tok.value === 'break') {
      next();
      match('PUNCT', ';');
      return { type: 'BreakStmt', line: tok.line, col: tok.col };
    }

    if (tok.type === 'KEYWORD' && tok.value === 'continue') {
      next();
      match('PUNCT', ';');
      return { type: 'ContinueStmt', line: tok.line, col: tok.col };
    }

    const COMPOUND_OPS = { '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%', '&=': '&', '|=': '|', '^=': '^' };

    // Atribuição: ident = expr; | ident += expr; | ident[idx] = expr; | ident.field = expr;
    if (tok.type === 'IDENT' && peek(1).type === 'OP' && (peek(1).value === '=' || COMPOUND_OPS[peek(1).value])) {
      const name = next().value;
      const opTok = next().value;
      const rhs = parseExpr();
      match('PUNCT', ';');
      const value = opTok === '='
        ? rhs
        : { type: 'BinaryExpr', op: COMPOUND_OPS[opTok], left: { type: 'IdentExpr', name, line: tok.line, col: tok.col }, right: rhs, line: tok.line, col: tok.col };
      return { type: 'AssignStmt', name, value, line: tok.line, col: tok.col };
    }
    if (tok.type === 'IDENT' && peek(1).type === 'PUNCT' && peek(1).value === '[') {
      const savedPos = pos;
      const name = next().value;
      next(); // '['
      const index = parseExpr();
      if (match('PUNCT', ']') && peek().type === 'OP' && (peek().value === '=' || COMPOUND_OPS[peek().value])) {
        const opTok = next().value;
        const rhs = parseExpr();
        match('PUNCT', ';');
        const value = opTok === '='
          ? rhs
          : {
              type: 'BinaryExpr',
              op: COMPOUND_OPS[opTok],
              left: { type: 'IndexExpr', target: { type: 'IdentExpr', name, line: tok.line, col: tok.col }, index, line: tok.line, col: tok.col },
              right: rhs,
              line: tok.line,
              col: tok.col
            };
        return { type: 'IndexAssignStmt', name, index, value, line: tok.line, col: tok.col };
      }
      pos = savedPos;
    }
    if (tok.type === 'IDENT' && peek(1).type === 'PUNCT' && peek(1).value === '.' && peek(2).type === 'IDENT' && peek(3).type === 'OP' && (peek(3).value === '=' || COMPOUND_OPS[peek(3).value])) {
      const name = next().value;
      next(); // '.'
      const field = next().value;
      const opTok = next().value;
      const rhs = parseExpr();
      match('PUNCT', ';');
      const value = opTok === '='
        ? rhs
        : {
            type: 'BinaryExpr',
            op: COMPOUND_OPS[opTok],
            left: { type: 'MemberExpr', target: { type: 'IdentExpr', name, line: tok.line, col: tok.col }, field, line: tok.line, col: tok.col },
            right: rhs,
            line: tok.line,
            col: tok.col
          };
      return { type: 'MemberAssignStmt', name, field, value, line: tok.line, col: tok.col };
    }

    const expr = parseExpr();
    match('PUNCT', ';');
    return { type: 'ExprStmt', expr, line: tok.line, col: tok.col };
  }

  function parseExpr() {
    return parseOr();
  }

  function parseOr() {
    let left = parseAnd();
    while (peek().type === 'KEYWORD' && peek().value === 'or') {
      const op = next().value;
      const right = parseAnd();
      left = { type: 'BinaryExpr', op, left, right, line: left.line, col: left.col };
    }
    return left;
  }

  function parseAnd() {
    let left = parseBitOr();
    while (peek().type === 'KEYWORD' && peek().value === 'and') {
      const op = next().value;
      const right = parseBitOr();
      left = { type: 'BinaryExpr', op, left, right, line: left.line, col: left.col };
    }
    return left;
  }

  function parseBitOr() {
    let left = parseBitXor();
    while (peek().type === 'OP' && peek().value === '|') {
      const op = next().value;
      const right = parseBitXor();
      left = { type: 'BinaryExpr', op, left, right, line: left.line, col: left.col };
    }
    return left;
  }

  function parseBitXor() {
    let left = parseBitAnd();
    while (peek().type === 'OP' && peek().value === '^') {
      const op = next().value;
      const right = parseBitAnd();
      left = { type: 'BinaryExpr', op, left, right, line: left.line, col: left.col };
    }
    return left;
  }

  function parseBitAnd() {
    let left = parseEquality();
    while (peek().type === 'OP' && peek().value === '&') {
      const op = next().value;
      const right = parseEquality();
      left = { type: 'BinaryExpr', op, left, right, line: left.line, col: left.col };
    }
    return left;
  }

  function parseEquality() {
    let left = parseComparison();
    while (peek().type === 'OP' && (peek().value === '==' || peek().value === '!=')) {
      const op = next().value;
      const right = parseComparison();
      left = { type: 'BinaryExpr', op, left, right, line: left.line, col: left.col };
    }
    return left;
  }

  function parseComparison() {
    let left = parseShift();
    while (peek().type === 'OP' && (peek().value === '<' || peek().value === '<=' || peek().value === '>' || peek().value === '>=')) {
      const op = next().value;
      const right = parseShift();
      left = { type: 'BinaryExpr', op, left, right, line: left.line, col: left.col };
    }
    return left;
  }

  function parseShift() {
    let left = parseAdditive();
    while (peek().type === 'OP' && (peek().value === '<<' || peek().value === '>>')) {
      const op = next().value;
      const right = parseAdditive();
      left = { type: 'BinaryExpr', op, left, right, line: left.line, col: left.col };
    }
    return left;
  }

  function parseAdditive() {
    let left = parseMultiplicative();
    while (peek().type === 'OP' && (peek().value === '+' || peek().value === '-')) {
      const op = next().value;
      const right = parseMultiplicative();
      left = { type: 'BinaryExpr', op, left, right, line: left.line, col: left.col };
    }
    return left;
  }

  function parseMultiplicative() {
    let left = parseUnary();
    while (peek().type === 'OP' && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = next().value;
      const right = parseUnary();
      left = { type: 'BinaryExpr', op, left, right, line: left.line, col: left.col };
    }
    return left;
  }

  function parseUnary() {
    const tok = peek();
    if ((tok.type === 'OP' && (tok.value === '-' || tok.value === '!' || tok.value === '~')) || (tok.type === 'KEYWORD' && tok.value === 'not')) {
      next();
      const operand = parseUnary();
      return { type: 'UnaryExpr', op: tok.value, operand, line: tok.line, col: tok.col };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();
    if (tok.type === 'INT') {
      next();
      return { type: 'IntLiteral', value: tok.value, line: tok.line, col: tok.col };
    }
    if (tok.type === 'FLOAT') {
      next();
      return { type: 'FloatLiteral', value: tok.value, line: tok.line, col: tok.col };
    }
    if (tok.type === 'STRING') {
      next();
      return { type: 'StringLiteral', value: tok.value, line: tok.line, col: tok.col };
    }
    if (tok.type === 'KEYWORD' && (tok.value === 'true' || tok.value === 'false')) {
      next();
      return { type: 'BoolLiteral', value: tok.value === 'true', line: tok.line, col: tok.col };
    }
    if (tok.type === 'PUNCT' && tok.value === '(') {
      next();
      const expr = parseExpr();
      expect('PUNCT', ')');
      return expr;
    }
    if (tok.type === 'PUNCT' && tok.value === '[') {
      next();
      const elements = [];
      while (peek().type !== 'PUNCT' || peek().value !== ']') {
        elements.push(parseExpr());
        if (!match('PUNCT', ',')) break;
      }
      expect('PUNCT', ']');
      return { type: 'ArrayLiteral', elements, line: tok.line, col: tok.col };
    }
    if (tok.type === 'IDENT' || (tok.type === 'KEYWORD' && tok.value === 'str' && peek(1).type === 'PUNCT' && peek(1).value === '.')) {
      next();
      let expr = null;
      if (tok.type === 'IDENT' && peek().type === 'PUNCT' && peek().value === '{' && peek(1).type === 'IDENT' && peek(2).type === 'PUNCT' && peek(2).value === ':') {
        next(); // '{'
        const fields = [];
        while (peek().type !== 'PUNCT' || peek().value !== '}') {
          const fName = expect('IDENT').value;
          expect('PUNCT', ':');
          const fVal = parseExpr();
          fields.push({ name: fName, value: fVal });
          if (!match('PUNCT', ',')) break;
        }
        expect('PUNCT', '}');
        expr = { type: 'StructLiteral', structName: tok.value, fields, line: tok.line, col: tok.col };
      } else if (peek().type === 'PUNCT' && peek().value === '.' && peek(1).type === 'IDENT' && peek(2).type === 'PUNCT' && peek(2).value === '(') {
        next(); // '.'
        const prop = next().value;
        const name = tok.value + '.' + prop;
        next(); // '('
        const args = [];
        while (peek().type !== 'PUNCT' || peek().value !== ')') {
          args.push(parseExpr());
          if (!match('PUNCT', ',')) break;
        }
        expect('PUNCT', ')');
        expr = { type: 'CallExpr', callee: name, args, line: tok.line, col: tok.col };
      } else if (match('PUNCT', '(')) {
        const args = [];
        while (peek().type !== 'PUNCT' || peek().value !== ')') {
          args.push(parseExpr());
          if (!match('PUNCT', ',')) break;
        }
        expect('PUNCT', ')');
        expr = { type: 'CallExpr', callee: tok.value, args, line: tok.line, col: tok.col };
      } else {
        expr = { type: 'IdentExpr', name: tok.value, line: tok.line, col: tok.col };
      }
      while (true) {
        if (match('PUNCT', '[')) {
          const index = parseExpr();
          expect('PUNCT', ']');
          expr = { type: 'IndexExpr', target: expr, index, line: tok.line, col: tok.col };
          continue;
        }
        if (match('PUNCT', '.')) {
          const field = expect('IDENT').value;
          expr = { type: 'MemberExpr', target: expr, field, line: tok.line, col: tok.col };
          continue;
        }
        break;
      }
      return expr;
    }

    throw new SyntaxError(`[Papaléguas Parser] Expressão inesperada '${tok.value}' em ${tok.line}:${tok.col}`);
  }

  return parseProgram();
}

module.exports = { parse };
