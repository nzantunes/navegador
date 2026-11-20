'use strict';

/**
 * Otimizador de AST da Linguagem Papaléguas (.ppl)
 * Executa passes seguros sobre a AST verificada antes do codegen C11 / WebAssembly:
 *  - Constant Folding (aritmética, lógica, comparações, bitwise)
 *  - Algebraic Simplification (x + 0, x * 1, x * 0, true and x, false or x)
 *  - Dead-Branch Pruning (if true / if false)
 *  - Dead-Code Elimination (statements após return / break / continue)
 */

function isIntLit(n) { return Boolean(n && n.type === 'IntLiteral'); }
function isFloatLit(n) { return Boolean(n && n.type === 'FloatLiteral'); }
function isBoolLit(n) { return Boolean(n && n.type === 'BoolLiteral'); }
function intVal(n) {
  if (!isIntLit(n)) return NaN;
  const v = typeof n.value === 'number' ? n.value : Number(n.value);
  return Number.isSafeInteger(v) ? v : NaN;
}
function floatVal(n) {
  if (!isFloatLit(n)) return NaN;
  const v = typeof n.value === 'number' ? n.value : Number(n.value);
  return Number.isFinite(v) ? v : NaN;
}

function optimizeAst(ast) {
  const stats = {
    foldedConstants: 0,
    algebraicSimplifications: 0,
    eliminatedDeadBranches: 0,
    eliminatedDeadStmts: 0
  };

  if (!ast || ast.type !== 'Program') return { ast, stats };

  // Coleta constantes escalares conhecidas em tempo de compilação
  const constScalars = new Map();
  for (const c of ast.consts || []) {
    if (c && c.init && (isIntLit(c.init) || isFloatLit(c.init) || isBoolLit(c.init))) {
      constScalars.set(c.name, c.init);
    }
  }

  function optExpr(node) {
    if (!node || typeof node !== 'object') return node;

    switch (node.type) {
      case 'UnaryExpr': {
        const operand = optExpr(node.operand);
        if ((node.op === 'not' || node.op === '!') && isBoolLit(operand)) {
          stats.foldedConstants++;
          return { type: 'BoolLiteral', value: !operand.value, line: node.line, col: node.col };
        }
        if (node.op === '-' && isIntLit(operand)) {
          const v = intVal(operand);
          if (Number.isSafeInteger(v)) {
            stats.foldedConstants++;
            return { type: 'IntLiteral', value: String(-v), line: node.line, col: node.col };
          }
        }
        if (node.op === '-' && isFloatLit(operand)) {
          const v = floatVal(operand);
          if (Number.isFinite(v)) {
            stats.foldedConstants++;
            return { type: 'FloatLiteral', value: String(-v), line: node.line, col: node.col };
          }
        }
        return Object.assign({}, node, { operand });
      }

      case 'BinaryExpr': {
        const left = optExpr(node.left);
        const right = optExpr(node.right);
        const op = node.op;

        // Constant folding: Int op Int (mantém seguro dentro de inteiros JS exatos)
        if (isIntLit(left) && isIntLit(right)) {
          const a = intVal(left);
          const b = intVal(right);
          if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) {
            if (op === '+' && Number.isSafeInteger(a + b)) { stats.foldedConstants++; return { type: 'IntLiteral', value: String(a + b), line: node.line, col: node.col }; }
            if (op === '-' && Number.isSafeInteger(a - b)) { stats.foldedConstants++; return { type: 'IntLiteral', value: String(a - b), line: node.line, col: node.col }; }
            if (op === '*' && Number.isSafeInteger(a * b)) { stats.foldedConstants++; return { type: 'IntLiteral', value: String(a * b), line: node.line, col: node.col }; }
            if (op === '/' && b !== 0 && a >= 0 && b > 0) { stats.foldedConstants++; return { type: 'IntLiteral', value: String(Math.trunc(a / b)), line: node.line, col: node.col }; }
            if (op === '%' && b !== 0 && a >= 0 && b > 0) { stats.foldedConstants++; return { type: 'IntLiteral', value: String(a % b), line: node.line, col: node.col }; }
            if (op === '==') { stats.foldedConstants++; return { type: 'BoolLiteral', value: a === b, line: node.line, col: node.col }; }
            if (op === '!=') { stats.foldedConstants++; return { type: 'BoolLiteral', value: a !== b, line: node.line, col: node.col }; }
            if (op === '<') { stats.foldedConstants++; return { type: 'BoolLiteral', value: a < b, line: node.line, col: node.col }; }
            if (op === '<=') { stats.foldedConstants++; return { type: 'BoolLiteral', value: a <= b, line: node.line, col: node.col }; }
            if (op === '>') { stats.foldedConstants++; return { type: 'BoolLiteral', value: a > b, line: node.line, col: node.col }; }
            if (op === '>=') { stats.foldedConstants++; return { type: 'BoolLiteral', value: a >= b, line: node.line, col: node.col }; }
          }
        }

        // Constant folding: Float op Float
        if (isFloatLit(left) && isFloatLit(right)) {
          const a = floatVal(left);
          const b = floatVal(right);
          if (Number.isFinite(a) && Number.isFinite(b)) {
            if (op === '+') { stats.foldedConstants++; return { type: 'FloatLiteral', value: String(a + b), line: node.line, col: node.col }; }
            if (op === '-') { stats.foldedConstants++; return { type: 'FloatLiteral', value: String(a - b), line: node.line, col: node.col }; }
            if (op === '*') { stats.foldedConstants++; return { type: 'FloatLiteral', value: String(a * b), line: node.line, col: node.col }; }
            if (op === '/' && b !== 0) { stats.foldedConstants++; return { type: 'FloatLiteral', value: String(a / b), line: node.line, col: node.col }; }
          }
        }

        // Constant folding: Bool op Bool
        if (isBoolLit(left) && isBoolLit(right)) {
          if (op === 'and') { stats.foldedConstants++; return { type: 'BoolLiteral', value: left.value && right.value, line: node.line, col: node.col }; }
          if (op === 'or') { stats.foldedConstants++; return { type: 'BoolLiteral', value: left.value || right.value, line: node.line, col: node.col }; }
          if (op === '==') { stats.foldedConstants++; return { type: 'BoolLiteral', value: left.value === right.value, line: node.line, col: node.col }; }
          if (op === '!=') { stats.foldedConstants++; return { type: 'BoolLiteral', value: left.value !== right.value, line: node.line, col: node.col }; }
        }

        // Algebraic simplifications (identidades seguras sem efeitos colaterais em operandos simples)
        if (op === '+' && isIntLit(right) && intVal(right) === 0) { stats.algebraicSimplifications++; return left; }
        if (op === '+' && isIntLit(left) && intVal(left) === 0) { stats.algebraicSimplifications++; return right; }
        if (op === '-' && isIntLit(right) && intVal(right) === 0) { stats.algebraicSimplifications++; return left; }
        if (op === '*' && isIntLit(right) && intVal(right) === 1) { stats.algebraicSimplifications++; return left; }
        if (op === '*' && isIntLit(left) && intVal(left) === 1) { stats.algebraicSimplifications++; return right; }
        if (op === 'and' && isBoolLit(left) && left.value === true) { stats.algebraicSimplifications++; return right; }
        if (op === 'and' && isBoolLit(right) && right.value === true) { stats.algebraicSimplifications++; return left; }
        if (op === 'or' && isBoolLit(left) && left.value === false) { stats.algebraicSimplifications++; return right; }
        if (op === 'or' && isBoolLit(right) && right.value === false) { stats.algebraicSimplifications++; return left; }

        return Object.assign({}, node, { left, right });
      }

      case 'CallExpr':
        return Object.assign({}, node, { args: (node.args || []).map(optExpr) });
      case 'ArrayLiteral':
        return Object.assign({}, node, { elements: (node.elements || []).map(optExpr) });
      case 'StructLiteral':
        return Object.assign({}, node, {
          fields: (node.fields || []).map((f) => Object.assign({}, f, { value: optExpr(f.value) }))
        });
      case 'IndexExpr':
        return Object.assign({}, node, { target: optExpr(node.target), index: optExpr(node.index) });
      case 'MemberExpr':
        return Object.assign({}, node, { target: optExpr(node.target) });
      default:
        return node;
    }
  }

  function optBlock(block) {
    if (!block || !Array.isArray(block.stmts)) return block;
    const outStmts = [];
    let terminated = false;

    for (const stmt of block.stmts) {
      if (terminated) {
        stats.eliminatedDeadStmts++;
        continue;
      }

      switch (stmt.type) {
        case 'LetStmt':
          outStmts.push(Object.assign({}, stmt, { init: optExpr(stmt.init) }));
          break;
        case 'AssignStmt':
          outStmts.push(Object.assign({}, stmt, { value: optExpr(stmt.value) }));
          break;
        case 'IndexAssignStmt':
          outStmts.push(Object.assign({}, stmt, { index: optExpr(stmt.index), value: optExpr(stmt.value) }));
          break;
        case 'MemberAssignStmt':
          outStmts.push(Object.assign({}, stmt, { value: optExpr(stmt.value) }));
          break;
        case 'ReturnStmt':
          outStmts.push(Object.assign({}, stmt, { value: stmt.value ? optExpr(stmt.value) : null }));
          terminated = true;
          break;
        case 'BreakStmt':
        case 'ContinueStmt':
          outStmts.push(stmt);
          terminated = true;
          break;
        case 'ExprStmt':
          outStmts.push(Object.assign({}, stmt, { expr: optExpr(stmt.expr) }));
          break;
        case 'IfStmt': {
          const test = optExpr(stmt.test);
          const cons = optBlock(stmt.consequent);
          const alt = stmt.alternate
            ? (stmt.alternate.type === 'Block' ? optBlock(stmt.alternate) : optBlock({ type: 'Block', stmts: [stmt.alternate], line: stmt.alternate.line, col: stmt.alternate.col }))
            : null;
          if (isBoolLit(test)) {
            stats.eliminatedDeadBranches++;
            const chosen = test.value ? cons : alt;
            if (chosen && Array.isArray(chosen.stmts)) {
              for (const cs of chosen.stmts) {
                outStmts.push(cs);
                if (cs.type === 'ReturnStmt' || cs.type === 'BreakStmt' || cs.type === 'ContinueStmt') {
                  terminated = true;
                  break;
                }
              }
            }
          } else {
            outStmts.push(Object.assign({}, stmt, { test, consequent: cons, alternate: alt }));
          }
          break;
        }
        case 'WhileStmt': {
          const test = optExpr(stmt.test);
          if (isBoolLit(test) && test.value === false) {
            stats.eliminatedDeadBranches++;
            break;
          }
          outStmts.push(Object.assign({}, stmt, { test, body: optBlock(stmt.body) }));
          break;
        }
        case 'ForStmt':
          outStmts.push(Object.assign({}, stmt, { start: optExpr(stmt.start), end: optExpr(stmt.end), body: optBlock(stmt.body) }));
          break;
        case 'MatchStmt':
          outStmts.push(Object.assign({}, stmt, {
            subject: optExpr(stmt.subject),
            arms: (stmt.arms || []).map((a) => Object.assign({}, a, {
              patterns: (a.patterns || []).map(optExpr),
              body: optBlock(a.body)
            }))
          }));
          break;
        default:
          outStmts.push(stmt);
      }
    }

    return Object.assign({}, block, { stmts: outStmts });
  }

  const optimizedFunctions = (ast.functions || []).map((fn) =>
    Object.assign({}, fn, { body: optBlock(fn.body) })
  );
  const optimizedConsts = (ast.consts || []).map((c) =>
    Object.assign({}, c, { init: optExpr(c.init) })
  );

  return {
    ast: Object.assign({}, ast, { consts: optimizedConsts, functions: optimizedFunctions }),
    stats
  };
}

module.exports = { optimizeAst };
