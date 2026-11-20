'use strict';

/**
 * Gerador WebAssembly Text (.wat) para a Linguagem Papaléguas (.ppl)
 * Compila funções puras .ppl para WebAssembly (.wasm) executável no navegador/frontend.
 */

function wasmType(pplType, enumMap = null) {
  if (enumMap && enumMap.has(pplType)) return 'i64';
  switch (pplType) {
    case 'f64': return 'f64';
    case 'bool': return 'i32';
    case 'u64':
    case 'i64': return 'i64';
    case 'void': return null;
    default: return null;
  }
}

function buildEnumMap(ast) {
  const enumMap = new Map();
  for (const en of ast.enums || []) {
    const vars = new Map();
    for (const v of en.variants || []) vars.set(v.name, v.value);
    enumMap.set(en.name, vars);
  }
  return enumMap;
}

const WASM_BUILTINS = new Set([
  'min_u64', 'max_u64', 'min_i64', 'max_i64', 'abs_i64', 'clamp_u64', 'clamp_i64', 'math.pct_u64', 'math.pow_u64'
]);

function selectWasmEligibleFunctions(ast, enumMap = buildEnumMap(ast)) {
  const allFns = ast.functions || [];
  const fnNames = new Set(allFns.map((f) => f.name));
  const candidateDeps = new Map();

  function scanExpr(e, deps) {
    if (!e) return true;
    if (e.type === 'MemberExpr' && e.target && e.target.type === 'IdentExpr' && enumMap.has(e.target.name)) return true;
    if (e.type === 'StringLiteral' || e.type === 'ArrayLiteral' || e.type === 'StructLiteral' || e.type === 'IndexExpr' || e.type === 'MemberExpr') return false;
    if (e.type === 'CallExpr') {
      if (!WASM_BUILTINS.has(e.callee)) {
        if (!fnNames.has(e.callee)) return false;
        deps.add(e.callee);
      }
      return (e.args || []).every((a) => scanExpr(a, deps));
    }
    if (e.type === 'UnaryExpr') return scanExpr(e.operand, deps);
    if (e.type === 'BinaryExpr') return scanExpr(e.left, deps) && scanExpr(e.right, deps);
    return true;
  }
  function scanBlock(b, deps) {
    if (!b || !b.stmts) return true;
    for (const s of b.stmts) {
      if (s.type === 'LetStmt' && (!wasmType(s.varType || 'u64', enumMap) || !scanExpr(s.init, deps))) return false;
      if (s.type === 'AssignStmt' && !scanExpr(s.value, deps)) return false;
      if (s.type === 'IndexAssignStmt' || s.type === 'MemberAssignStmt') return false;
      if (s.type === 'ReturnStmt' && s.value && !scanExpr(s.value, deps)) return false;
      if (s.type === 'ExprStmt' && !scanExpr(s.expr, deps)) return false;
      if (s.type === 'IfStmt') {
        if (!scanExpr(s.test, deps) || !scanBlock(s.consequent, deps)) return false;
        if (s.alternate && !(s.alternate.type === 'Block' ? scanBlock(s.alternate, deps) : scanBlock({ stmts: [s.alternate] }, deps))) return false;
      }
      if (s.type === 'MatchStmt') {
        if (!scanExpr(s.subject, deps)) return false;
        for (const arm of s.arms || []) {
          if (!(arm.patterns || []).every((p) => scanExpr(p, deps)) || !scanBlock(arm.body, deps)) return false;
        }
      }
      if (s.type === 'WhileStmt' && (!scanExpr(s.test, deps) || !scanBlock(s.body, deps))) return false;
      if (s.type === 'ForStmt' && (!scanExpr(s.start, deps) || !scanExpr(s.end, deps) || !scanBlock(s.body, deps))) return false;
    }
    return true;
  }

  const eligible = new Set();
  for (const fn of allFns) {
    if (fn.returnType !== 'void' && !wasmType(fn.returnType, enumMap)) continue;
    if (!(fn.params || []).every((p) => wasmType(p.paramType, enumMap))) continue;
    const deps = new Set();
    if (!scanBlock(fn.body, deps)) continue;
    eligible.add(fn.name);
    candidateDeps.set(fn.name, deps);
  }

  // Fechamento transitivo: remove funções que chamem alguma função não elegível
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of Array.from(eligible)) {
      const deps = candidateDeps.get(name);
      for (const d of deps) {
        if (!eligible.has(d)) {
          eligible.delete(name);
          changed = true;
          break;
        }
      }
    }
  }

  return allFns.filter((fn) => eligible.has(fn.name));
}

function isWasmSupportedModule(ast, enumMap = buildEnumMap(ast)) {
  return selectWasmEligibleFunctions(ast, enumMap).length > 0;
}

function generateWat(ast) {
  const enumMap = buildEnumMap(ast);
  const eligibleFns = selectWasmEligibleFunctions(ast, enumMap);
  if (eligibleFns.length === 0) return null;
  const lines = ['(module'];
  lines.push('  (func $__ppl_pow_u64 (param $base i64) (param $exp i64) (result i64)');
  lines.push('    (local $r i64) (local $b i64) (local $e i64)');
  lines.push('    (local.set $r (i64.const 1))');
  lines.push('    (local.set $b (local.get $base))');
  lines.push('    (local.set $e (if (result i64) (i64.gt_u (local.get $exp) (i64.const 63)) (then (i64.const 63)) (else (local.get $exp))))');
  lines.push('    (block $brk (loop $lp');
  lines.push('      (br_if $brk (i64.eqz (local.get $e)))');
  lines.push('      (if (i64.ne (i64.and (local.get $e) (i64.const 1)) (i64.const 0)) (then (local.set $r (i64.mul (local.get $r) (local.get $b)))))');
  lines.push('      (local.set $b (i64.mul (local.get $b) (local.get $b)))');
  lines.push('      (local.set $e (i64.shr_u (local.get $e) (i64.const 1)))');
  lines.push('      (br $lp)');
  lines.push('    ))');
  lines.push('    (local.get $r)');
  lines.push('  )');
  const fnReturnMap = new Map();
  for (const fn of eligibleFns) fnReturnMap.set(fn.name, wasmType(fn.returnType, enumMap) || 'i64');
  const constMap = new Map();
  for (const c of ast.consts || []) {
    if (!c.init) continue;
    if (c.init.type === 'IntLiteral') {
      constMap.set(c.name, { type: c.varType, val: c.init.value });
    } else if (c.init.type === 'BoolLiteral') {
      constMap.set(c.name, { type: 'bool', val: c.init.value ? 1 : 0 });
    } else if (c.init.type === 'FloatLiteral') {
      constMap.set(c.name, { type: 'f64', val: c.init.value });
    }
  }

  let blockSeq = 0;

  for (const fn of eligibleFns) {
    const locals = new Map();
    const params = fn.params || [];
    for (const p of params) locals.set(p.name, p.paramType);

    function collectLocals(block) {
      for (const s of (block && block.stmts) || []) {
        if (s.type === 'LetStmt') locals.set(s.name, s.varType || 'u64');
        if (s.type === 'ForStmt') {
          locals.set(s.iter, 'u64');
          collectLocals(s.body);
        }
        if (s.type === 'WhileStmt') collectLocals(s.body);
        if (s.type === 'IfStmt') {
          collectLocals(s.consequent);
          if (s.alternate) collectLocals(s.alternate.type === 'Block' ? s.alternate : { stmts: [s.alternate] });
        }
        if (s.type === 'MatchStmt') {
          for (const arm of s.arms || []) collectLocals(arm.body);
        }
      }
    }
    collectLocals(fn.body);

    const paramSig = params.map((p) => `(param $${p.name} ${wasmType(p.paramType, enumMap)})`).join(' ');
    const retWt = wasmType(fn.returnType, enumMap);
    const retSig = retWt ? `(result ${retWt})` : '';
    const exportAttr = fn.isExport ? `(export "${fn.name}") ` : '';
    lines.push(`  (func $${fn.name} ${exportAttr}${paramSig} ${retSig}`.trimEnd());

    const paramNames = new Set(params.map((p) => p.name));
    for (const [lName, lType] of locals.entries()) {
      if (!paramNames.has(lName)) {
        lines.push(`    (local $${lName} ${wasmType(lType, enumMap) || 'i64'})`);
      }
    }
    lines.push('    (local $__tmp_end i64)');
    lines.push('    (local $__tmp_match i64)');
    lines.push('    (local $__tmp_match32 i32)');

    function inferWasmExprType(e) {
      if (!e) return 'i64';
      if (e.type === 'FloatLiteral') return 'f64';
      if (e.type === 'BoolLiteral') return 'i32';
      if (e.type === 'IntLiteral') return 'i64';
      if (e.type === 'IdentExpr') {
        if (constMap.has(e.name)) return wasmType(constMap.get(e.name).type) || 'i64';
        return wasmType(locals.get(e.name)) || 'i64';
      }
      if (e.type === 'BinaryExpr') {
        if (['==', '!=', '<', '<=', '>', '>=', 'and', 'or'].includes(e.op)) return 'i32';
        if (inferWasmExprType(e.left) === 'f64' || inferWasmExprType(e.right) === 'f64') return 'f64';
        return 'i64';
      }
      if (e.type === 'UnaryExpr') return e.op === 'not' || e.op === '!' ? 'i32' : inferWasmExprType(e.operand);
      if (e.type === 'CallExpr') {
        if (fnReturnMap.has(e.callee)) return fnReturnMap.get(e.callee);
        return 'i64';
      }
      return 'i64';
    }

    function coerceToWasmType(exprCode, actualType, expectedType) {
      if (!expectedType || actualType === expectedType) return exprCode;
      if (expectedType === 'f64' && actualType === 'i64') return `(f64.convert_i64_s ${exprCode})`;
      return exprCode;
    }

    function emitExpr(e, pad) {
      switch (e.type) {
        case 'IntLiteral': return `${pad}(i64.const ${e.value})`;
        case 'FloatLiteral': return `${pad}(f64.const ${Number(e.value)})`;
        case 'BoolLiteral': return `${pad}(i32.const ${e.value ? 1 : 0})`;
        case 'IdentExpr':
          if (constMap.has(e.name)) {
            const c = constMap.get(e.name);
            const wt = wasmType(c.type) || 'i64';
            return `${pad}(${wt}.const ${wt === 'f64' ? Number(c.val) : c.val})`;
          }
          return `${pad}(local.get $${e.name})`;
        case 'MemberExpr':
          if (e.target && e.target.type === 'IdentExpr' && enumMap.has(e.target.name)) {
            const val = enumMap.get(e.target.name).get(e.field) || 0;
            return `${pad}(i64.const ${val})`;
          }
          return `${pad}(i64.const 0)`;
        case 'UnaryExpr': {
          const inner = emitExpr(e.operand, '');
          if (e.op === 'not' || e.op === '!') return `${pad}(i32.eqz ${inner})`;
          if (e.op === '~') return `${pad}(i64.xor ${inner} (i64.const -1))`;
          const t = inferWasmExprType(e.operand);
          if (t === 'f64') return `${pad}(f64.neg ${inner})`;
          return `${pad}(i64.sub (i64.const 0) ${inner})`;
        }
        case 'BinaryExpr': {
          const l = emitExpr(e.left, '');
          const r = emitExpr(e.right, '');
          const lt = inferWasmExprType(e.left);
          const rt = inferWasmExprType(e.right);
          const isF = lt === 'f64' || rt === 'f64';
          const isB = lt === 'i32' && rt === 'i32';
          if (e.op === 'and') return `${pad}(i32.and ${l} ${r})`;
          if (e.op === 'or') return `${pad}(i32.or ${l} ${r})`;
          const prefix = isF ? 'f64' : (isB ? 'i32' : 'i64');
          const opMap = {
            '+': 'add', '-': 'sub', '*': 'mul',
            '/': isF ? 'div' : 'div_u', '%': 'rem_u',
            '&': 'and', '|': 'or', '^': 'xor',
            '<<': 'shl', '>>': 'shr_u',
            '==': 'eq', '!=': 'ne',
            '<': isF ? 'lt' : 'lt_s', '<=': isF ? 'le' : 'le_s',
            '>': isF ? 'gt' : 'gt_s', '>=': isF ? 'ge' : 'ge_s'
          };
          return `${pad}(${prefix}.${opMap[e.op] || 'add'} ${l} ${r})`;
        }
        case 'CallExpr': {
          const args = (e.args || []).map((a) => emitExpr(a, '')).join(' ');
          if (e.callee === 'min_u64') {
            return `${pad}(if (result i64) (i64.lt_u ${emitExpr(e.args[0], '')} ${emitExpr(e.args[1], '')}) (then ${emitExpr(e.args[0], '')}) (else ${emitExpr(e.args[1], '')}))`;
          }
          if (e.callee === 'max_u64') {
            return `${pad}(if (result i64) (i64.gt_u ${emitExpr(e.args[0], '')} ${emitExpr(e.args[1], '')}) (then ${emitExpr(e.args[0], '')}) (else ${emitExpr(e.args[1], '')}))`;
          }
          if (e.callee === 'min_i64') {
            return `${pad}(if (result i64) (i64.lt_s ${emitExpr(e.args[0], '')} ${emitExpr(e.args[1], '')}) (then ${emitExpr(e.args[0], '')}) (else ${emitExpr(e.args[1], '')}))`;
          }
          if (e.callee === 'max_i64') {
            return `${pad}(if (result i64) (i64.gt_s ${emitExpr(e.args[0], '')} ${emitExpr(e.args[1], '')}) (then ${emitExpr(e.args[0], '')}) (else ${emitExpr(e.args[1], '')}))`;
          }
          if (e.callee === 'abs_i64') {
            const x = emitExpr(e.args[0], '');
            return `${pad}(if (result i64) (i64.lt_s ${x} (i64.const 0)) (then (i64.sub (i64.const 0) ${x})) (else ${x}))`;
          }
          if (e.callee === 'clamp_u64') {
            const v = emitExpr(e.args[0], '');
            const lo = emitExpr(e.args[0] && e.args[1], '');
            const hi = emitExpr(e.args[2], '');
            return `${pad}(if (result i64) (i64.lt_u ${v} ${lo}) (then ${lo}) (else (if (result i64) (i64.gt_u ${v} ${hi}) (then ${hi}) (else ${v}))))`;
          }
          if (e.callee === 'clamp_i64') {
            const v = emitExpr(e.args[0], '');
            const lo = emitExpr(e.args[1], '');
            const hi = emitExpr(e.args[2], '');
            return `${pad}(if (result i64) (i64.lt_s ${v} ${lo}) (then ${lo}) (else (if (result i64) (i64.gt_s ${v} ${hi}) (then ${hi}) (else ${v}))))`;
          }
          if (e.callee === 'math.pct_u64') {
            const part = emitExpr(e.args[0], '');
            const tot = emitExpr(e.args[1], '');
            return `${pad}(if (result i64) (i64.eqz ${tot}) (then (i64.const 0)) (else (i64.div_u (i64.mul ${part} (i64.const 100)) ${tot})))`;
          }
          if (e.callee === 'math.pow_u64') {
            return `${pad}(call $__ppl_pow_u64 ${emitExpr(e.args[0], '')} ${emitExpr(e.args[1], '')})`;
          }
          return `${pad}(call $${e.callee}${args ? ' ' + args : ''})`;
        }
        default: return `${pad}(i64.const 0)`;
      }
    }

    const loopStack = [];

    function emitBlock(block, indent) {
      const pad = '  '.repeat(indent);
      for (const s of (block && block.stmts) || []) {
        if (s.type === 'LetStmt' || s.type === 'AssignStmt') {
          const valNode = s.type === 'LetStmt' ? s.init : s.value;
          const expectedWt = wasmType(locals.get(s.name), enumMap) || 'i64';
          const actualWt = inferWasmExprType(valNode);
          const emitted = coerceToWasmType(emitExpr(valNode, ''), actualWt, expectedWt);
          lines.push(`${pad}(local.set $${s.name} ${emitted})`);
        } else if (s.type === 'ReturnStmt') {
          if (s.value) {
            const actualWt = inferWasmExprType(s.value);
            const emitted = retWt ? coerceToWasmType(emitExpr(s.value, ''), actualWt, retWt) : emitExpr(s.value, '');
            lines.push(`${pad}(return ${emitted})`);
          } else {
            lines.push(`${pad}(return)`);
          }
        } else if (s.type === 'BreakStmt') {
          const top = loopStack[loopStack.length - 1];
          if (top) lines.push(`${pad}(br $${top.brk})`);
        } else if (s.type === 'ContinueStmt') {
          const top = loopStack[loopStack.length - 1];
          if (top) lines.push(`${pad}(br $${top.cnt})`);
        } else if (s.type === 'ExprStmt') {
          lines.push(`${pad}(drop ${emitExpr(s.expr, '')})`);
        } else if (s.type === 'IfStmt') {
          lines.push(`${pad}(if ${emitExpr(s.test, '')}`);
          lines.push(`${pad}  (then`);
          emitBlock(s.consequent, indent + 2);
          lines.push(`${pad}  )`);
          if (s.alternate) {
            lines.push(`${pad}  (else`);
            emitBlock(s.alternate.type === 'Block' ? s.alternate : { stmts: [s.alternate] }, indent + 2);
            lines.push(`${pad}  )`);
          }
          lines.push(`${pad})`);
        } else if (s.type === 'MatchStmt') {
          const isB = inferWasmExprType(s.subject) === 'i32';
          const tmpVar = isB ? '$__tmp_match32' : '$__tmp_match';
          const eqOp = isB ? 'i32.eq' : 'i64.eq';
          lines.push(`${pad}(local.set ${tmpVar} ${emitExpr(s.subject, '')})`);
          const condArms = [];
          let wildcardArm = null;
          for (const arm of s.arms || []) {
            if (arm.isWildcard && (!arm.patterns || arm.patterns.length === 0)) {
              wildcardArm = arm;
              continue;
            }
            if (arm.isWildcard) wildcardArm = arm;
            if (arm.patterns && arm.patterns.length > 0) condArms.push(arm);
          }
          function emitMatchChain(idx, curIndent) {
            const cPad = '  '.repeat(curIndent);
            if (idx >= condArms.length) {
              if (wildcardArm) emitBlock(wildcardArm.body, curIndent);
              return;
            }
            const arm = condArms[idx];
            let condExpr = arm.patterns.map((pat) => `(${eqOp} (local.get ${tmpVar}) ${emitExpr(pat, '')})`);
            let joined = condExpr[0];
            for (let k = 1; k < condExpr.length; k++) joined = `(i32.or ${joined} ${condExpr[k]})`;
            lines.push(`${cPad}(if ${joined}`);
            lines.push(`${cPad}  (then`);
            emitBlock(arm.body, curIndent + 2);
            lines.push(`${cPad}  )`);
            if (idx + 1 < condArms.length || wildcardArm) {
              lines.push(`${cPad}  (else`);
              emitMatchChain(idx + 1, curIndent + 2);
              lines.push(`${cPad}  )`);
            }
            lines.push(`${cPad})`);
          }
          emitMatchChain(0, indent);
        } else if (s.type === 'WhileStmt') {
          const id = ++blockSeq;
          lines.push(`${pad}(block $brk_${id}`);
          lines.push(`${pad}  (loop $lp_${id}`);
          lines.push(`${pad}    (br_if $brk_${id} (i32.eqz ${emitExpr(s.test, '')}))`);
          loopStack.push({ brk: `brk_${id}`, cnt: `lp_${id}` });
          emitBlock(s.body, indent + 2);
          loopStack.pop();
          lines.push(`${pad}    (br $lp_${id})`);
          lines.push(`${pad}  )`);
          lines.push(`${pad})`);
        } else if (s.type === 'ForStmt') {
          const id = ++blockSeq;
          lines.push(`${pad}(local.set $${s.iter} ${emitExpr(s.start, '')})`);
          lines.push(`${pad}(local.set $__tmp_end ${emitExpr(s.end, '')})`);
          lines.push(`${pad}(block $brk_${id}`);
          lines.push(`${pad}  (loop $lp_${id}`);
          lines.push(`${pad}    (br_if $brk_${id} (${s.inclusive ? 'i64.gt_u' : 'i64.ge_u'} (local.get $${s.iter}) (local.get $__tmp_end)))`);
          lines.push(`${pad}    (block $cnt_${id}`);
          loopStack.push({ brk: `brk_${id}`, cnt: `cnt_${id}` });
          emitBlock(s.body, indent + 3);
          loopStack.pop();
          lines.push(`${pad}    )`);
          lines.push(`${pad}    (local.set $${s.iter} (i64.add (local.get $${s.iter}) (i64.const 1)))`);
          lines.push(`${pad}    (br $lp_${id})`);
          lines.push(`${pad}  )`);
          lines.push(`${pad})`);
        }
      }
    }

    emitBlock(fn.body, 2);
    if (retWt === 'i64') lines.push('    (i64.const 0)');
    else if (retWt === 'f64') lines.push('    (f64.const 0.0)');
    else if (retWt === 'i32') lines.push('    (i32.const 0)');
    lines.push('  )');
  }

  lines.push(')');
  return lines.join('\n');
}

module.exports = { generateWat, isWasmSupportedModule, selectWasmEligibleFunctions };
