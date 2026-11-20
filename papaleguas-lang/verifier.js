'use strict';

/**
 * Verificador Estático de Tipos e Segurança da Linguagem Papaléguas (.ppl)
 * Rejeita em tempo de compilação operações inseguras, variáveis não declaradas,
 * incompatibilidades de tipo, divisão por zero literal e loops sem proteção.
 */

const FORBIDDEN_CALLS = new Set([
  'eval', 'exec', 'system', 'popen', 'shell', 'fork', 'dlopen',
  'raw_ptr', 'unsafe_cast', 'malloc', 'free', 'memcpy', 'strcpy'
]);

const BUILTINS = {
  'hw.cpu_cores': { params: [], returnType: 'u64' },
  'hw.ram_total_mb': { params: [], returnType: 'u64' },
  'hw.ram_free_mb': { params: [], returnType: 'u64' },
  'hw.monotonic_ns': { params: [], returnType: 'u64' },
  'hw.uptime_sec': { params: [], returnType: 'u64' },
  'hw.hash_fnv1a': { params: ['str'], returnType: 'u64' },
  'str.len': { params: ['str'], returnType: 'u64' },
  'str.is_empty': { params: ['str'], returnType: 'bool' },
  'str.contains': { params: ['str', 'str'], returnType: 'bool' },
  'str.starts_with': { params: ['str', 'str'], returnType: 'bool' },
  'str.starts_with_ci': { params: ['str', 'str'], returnType: 'bool' },
  'str.ends_with': { params: ['str', 'str'], returnType: 'bool' },
  'str.ends_with_ci': { params: ['str', 'str'], returnType: 'bool' },
  'str.eq': { params: ['str', 'str'], returnType: 'bool' },
  'str.equals_ci': { params: ['str', 'str'], returnType: 'bool' },
  'str.hash_fnv1a_ci': { params: ['str'], returnType: 'u64' },
  'str.concat': { params: ['str', 'str'], returnType: 'str' },
  'str.to_lower': { params: ['str'], returnType: 'str' },
  'str.to_upper': { params: ['str'], returnType: 'str' },
  'str.trim': { params: ['str'], returnType: 'str' },
  'str.slice': { params: ['str', 'u64', 'u64'], returnType: 'str' },
  'str.replace': { params: ['str', 'str', 'str'], returnType: 'str' },
  'str.index_of': { params: ['str', 'str'], returnType: 'i64' },
  'str.count': { params: ['str', 'str'], returnType: 'u64' },
  'str.is_ascii_alnum': { params: ['str'], returnType: 'bool' },
  'str.contains_ci': { params: ['str', 'str'], returnType: 'bool' },
  'str.from_u64': { params: ['u64'], returnType: 'str' },
  'str.levenshtein': { params: ['str', 'str'], returnType: 'u64' },
  'str.upper_ratio_pct': { params: ['str'], returnType: 'u64' },
  'str.strip_html': { params: ['str'], returnType: 'str' },
  'str.fold_diacritics': { params: ['str'], returnType: 'str' },
  'net.listen': { params: ['u64'], returnType: 'i64', requiresNetwork: true },
  'net.accept': { params: ['i64'], returnType: 'i64', requiresNetwork: true },
  'net.read_req': { params: ['i64'], returnType: 'str', requiresNetwork: true },
  'net.req_path': { params: ['str'], returnType: 'str', requiresNetwork: true },
  'net.req_method': { params: ['str'], returnType: 'str', requiresNetwork: true },
  'net.req_query': { params: ['str', 'str'], returnType: 'str', requiresNetwork: true },
  'net.req_body': { params: ['str'], returnType: 'str', requiresNetwork: true },
  'net.send_http': { params: ['i64', 'u64', 'str', 'str'], returnType: 'bool', requiresNetwork: true },
  'net.close': { params: ['i64'], returnType: 'void', requiresNetwork: true },
  'net.spawn_handle_client': { params: ['i64'], returnType: 'bool', requiresNetwork: true },
  'net.send_file_safe': { params: ['i64', 'str', 'str', 'str'], returnType: 'bool', requiresNetwork: true, requiresFs: true },
  'net.serve_static': { params: ['i64', 'str', 'str'], returnType: 'bool', requiresNetwork: true, requiresFs: true },
  'net.http_get': { params: ['str', 'u64', 'str'], returnType: 'str', requiresNetwork: true },
  'net.proxy_pass': { params: ['i64', 'str', 'u64', 'str'], returnType: 'bool', requiresNetwork: true },
  'net.relay_image': { params: ['i64', 'str'], returnType: 'bool', requiresNetwork: true },
  'net.fetch_meta': { params: ['str'], returnType: 'str', requiresNetwork: true },
  'net.metrics_json': { params: [], returnType: 'str', requiresNetwork: true },
  'net.tor_fetch': { params: ['str', 'u64', 'str', 'u64', 'str', 'bool'], returnType: 'str', requiresNetwork: true },
  'net.tor_alive': { params: ['str', 'u64'], returnType: 'bool', requiresNetwork: true },
  'net.client_ip_blocked': { params: ['i64', 'str'], returnType: 'bool', requiresNetwork: true },
  'fs.read_safe': { params: ['str', 'str'], returnType: 'str', requiresFs: true },
  'clamp_u64': { params: ['u64', 'u64', 'u64'], returnType: 'u64' },
  'clamp_i64': { params: ['i64', 'i64', 'i64'], returnType: 'i64' },
  'abs_i64': { params: ['i64'], returnType: 'u64' },
  'min_i64': { params: ['i64', 'i64'], returnType: 'i64' },
  'max_i64': { params: ['i64', 'i64'], returnType: 'i64' },
  'math.pow_u64': { params: ['u64', 'u64'], returnType: 'u64' },
  'math.pct_u64': { params: ['u64', 'u64'], returnType: 'u64' },
  'min_u64': { params: ['u64', 'u64'], returnType: 'u64' },
  'max_u64': { params: ['u64', 'u64'], returnType: 'u64' }
};

function parseArrayType(t) {
  const m = typeof t === 'string' && t.match(/^\[(\d+)\](.+)$/);
  return m ? { size: Number(m[1]), elemType: m[2] } : null;
}

function isNumericType(t) {
  return t === 'u64' || t === 'i64' || t === 'f64';
}

function typesCompatible(expected, actual) {
  if (expected === actual) return true;
  if (expected === 'f64' && (actual === 'u64' || actual === 'i64')) return true;
  if (expected === 'i64' && actual === 'u64') return true;
  if (expected === 'u64' && actual === 'i64') return true; // checado por bounds em runtime quando necessário
  return false;
}

function verify(ast) {
  const errors = [];
  const warnings = [];
  const fnTable = new Map();
  const constTable = new Map();
  const structTable = new Map();
  const enumTable = new Map();

  const isEnumType = (t) => enumTable.has(t);
  const compatType = (expected, actual) => {
    if (typesCompatible(expected, actual)) return true;
    if (isEnumType(expected) && (actual === 'u64' || actual === 'i64')) return true;
    if ((expected === 'u64' || expected === 'i64') && isEnumType(actual)) return true;
    return false;
  };

  const modulePolicy = {};
  for (const p of ast.policies || []) {
    Object.assign(modulePolicy, p.rules || {});
  }

  for (const en of ast.enums || []) {
    if (enumTable.has(en.name) || structTable.has(en.name)) {
      errors.push(`[${en.line}:${en.col}] Enum duplicado '${en.name}'`);
      continue;
    }
    const variants = new Map();
    for (const v of en.variants || []) {
      if (variants.has(v.name)) {
        errors.push(`[${en.line}:${en.col}] Variante duplicada '${v.name}' no enum '${en.name}'`);
      } else {
        variants.set(v.name, v.value);
      }
    }
    enumTable.set(en.name, variants);
  }

  for (const s of ast.structs || []) {
    if (structTable.has(s.name)) {
      errors.push(`[${s.line}:${s.col}] Struct duplicada '${s.name}'`);
      continue;
    }
    const fieldMap = new Map();
    for (const f of s.fields || []) {
      if (fieldMap.has(f.name)) {
        errors.push(`[${s.line}:${s.col}] Campo duplicado '${f.name}' na struct '${s.name}'`);
      } else if (f.fieldType === s.name) {
        errors.push(`[${s.line}:${s.col}] Struct '${s.name}' não pode conter a si mesma`);
      } else {
        fieldMap.set(f.name, f.fieldType);
      }
    }
    structTable.set(s.name, fieldMap);
  }

  for (const c of ast.consts || []) {
    if (constTable.has(c.name)) {
      errors.push(`[${c.line}:${c.col}] Constante duplicada '${c.name}'`);
    } else {
      const t = inferExpr(c.init, new Map());
      if (t && !typesCompatible(c.varType, t)) {
        errors.push(`[${c.line}:${c.col}] Constante '${c.name}' espera '${c.varType}', recebeu '${t}'`);
      }
      constTable.set(c.name, { type: c.varType, isConst: true });
    }
  }

  for (const fn of ast.functions || []) {
    if (fnTable.has(fn.name)) {
      errors.push(`[${fn.line}:${fn.col}] Função duplicada '${fn.name}'`);
      continue;
    }
    fnTable.set(fn.name, {
      params: fn.params.map((p) => p.paramType),
      returnType: fn.returnType
    });
  }

  let activePolicy = modulePolicy;

  function inferExpr(node, scope) {
    if (!node) return 'void';
    switch (node.type) {
      case 'IntLiteral':
        return 'u64';
      case 'FloatLiteral':
        return 'f64';
      case 'BoolLiteral':
        return 'bool';
      case 'StringLiteral':
        return 'str';
      case 'IdentExpr': {
        if (scope.has(node.name)) return scope.get(node.name).type;
        if (constTable.has(node.name)) return constTable.get(node.name).type;
        errors.push(`[${node.line}:${node.col}] Identificador não declarado '${node.name}'`);
        return null;
      }
      case 'UnaryExpr': {
        const inner = inferExpr(node.operand, scope);
        if (node.op === 'not' || node.op === '!') {
          if (inner && inner !== 'bool') {
            errors.push(`[${node.line}:${node.col}] Operador '${node.op}' exige 'bool', recebeu '${inner}'`);
          }
          return 'bool';
        }
        if (node.op === '~') {
          if (inner && inner !== 'u64' && inner !== 'i64') {
            errors.push(`[${node.line}:${node.col}] Operador bitwise '~' exige inteiro (u64/i64), recebeu '${inner}'`);
          }
          return inner || 'u64';
        }
        if (node.op === '-') {
          if (inner && !isNumericType(inner)) {
            errors.push(`[${node.line}:${node.col}] Negação '-' exige tipo numérico, recebeu '${inner}'`);
          }
          return inner === 'u64' ? 'i64' : inner;
        }
        return inner;
      }
      case 'BinaryExpr': {
        const lt = inferExpr(node.left, scope);
        const rt = inferExpr(node.right, scope);
        if ((node.op === '/' || node.op === '%') && node.right.type === 'IntLiteral' && Number(node.right.value) === 0) {
          errors.push(`[${node.line}:${node.col}] Divisão ou módulo por zero literal bloqueado por segurança`);
        }
        if (node.op === 'and' || node.op === 'or') {
          if (lt && lt !== 'bool') errors.push(`[${node.line}:${node.col}] '${node.op}' exige bool à esquerda`);
          if (rt && rt !== 'bool') errors.push(`[${node.line}:${node.col}] '${node.op}' exige bool à direita`);
          return 'bool';
        }
        if (node.op === '==' || node.op === '!=' || node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=') {
          return 'bool';
        }
        if (node.op === '&' || node.op === '|' || node.op === '^' || node.op === '<<' || node.op === '>>') {
          if ((lt && lt !== 'u64' && lt !== 'i64') || (rt && rt !== 'u64' && rt !== 'i64')) {
            errors.push(`[${node.line}:${node.col}] Operação bitwise '${node.op}' exige inteiros (u64/i64), recebeu '${lt}' e '${rt}'`);
          }
          return (lt === 'i64' || rt === 'i64') ? 'i64' : 'u64';
        }
        if (lt && rt && (!isNumericType(lt) || !isNumericType(rt))) {
          errors.push(`[${node.line}:${node.col}] Operação '${node.op}' inválida entre '${lt}' e '${rt}'`);
        }
        if (lt === 'f64' || rt === 'f64') return 'f64';
        if (lt === 'i64' || rt === 'i64') return 'i64';
        return 'u64';
      }
      case 'CallExpr': {
        if (FORBIDDEN_CALLS.has(node.callee)) {
          errors.push(`[${node.line}:${node.col}] Chamada insegura '${node.callee}' proibida pela política Papaléguas`);
          return null;
        }
        const sig = BUILTINS[node.callee] || fnTable.get(node.callee);
        if (!sig) {
          errors.push(`[${node.line}:${node.col}] Função desconhecida '${node.callee}'`);
          return null;
        }
        if (sig.requiresNetwork && !activePolicy.allow_network) {
          errors.push(`[${node.line}:${node.col}] Chamada de rede '${node.callee}' exige @policy(allow_network=true)`);
        }
        if (sig.requiresFs && !activePolicy.allow_fs) {
          errors.push(`[${node.line}:${node.col}] Chamada de arquivo '${node.callee}' exige @policy(allow_fs=true)`);
        }
        if (node.args.length !== sig.params.length) {
          errors.push(`[${node.line}:${node.col}] '${node.callee}' espera ${sig.params.length} argumento(s), recebeu ${node.args.length}`);
        } else {
          for (let i = 0; i < node.args.length; i++) {
            const at = inferExpr(node.args[i], scope);
            if (at && !typesCompatible(sig.params[i], at)) {
              errors.push(`[${node.line}:${node.col}] Argumento ${i + 1} de '${node.callee}' espera '${sig.params[i]}', recebeu '${at}'`);
            }
          }
        }
        return sig.returnType;
      }
      case 'ArrayLiteral': {
        if (!node.elements || node.elements.length === 0) {
          errors.push(`[${node.line}:${node.col}] Array literal vazio não é permitido`);
          return null;
        }
        if (node.elements.length > 65536) {
          errors.push(`[${node.line}:${node.col}] Array literal excede limite seguro de 65536 elementos`);
        }
        const firstType = inferExpr(node.elements[0], scope);
        for (let i = 1; i < node.elements.length; i++) {
          const elType = inferExpr(node.elements[i], scope);
          if (firstType && elType && !typesCompatible(firstType, elType)) {
            errors.push(`[${node.line}:${node.col}] Elemento ${i} do array espera '${firstType}', recebeu '${elType}'`);
          }
        }
        return firstType ? `[${node.elements.length}]${firstType}` : null;
      }
      case 'StructLiteral': {
        const fieldMap = structTable.get(node.structName);
        if (!fieldMap) {
          errors.push(`[${node.line}:${node.col}] Struct desconhecida '${node.structName}'`);
          return null;
        }
        const provided = new Set();
        for (const f of node.fields || []) {
          if (!fieldMap.has(f.name)) {
            errors.push(`[${node.line}:${node.col}] Campo '${f.name}' não existe na struct '${node.structName}'`);
            continue;
          }
          provided.add(f.name);
          const expected = fieldMap.get(f.name);
          const actual = inferExpr(f.value, scope);
          if (actual && !typesCompatible(expected, actual)) {
            errors.push(`[${node.line}:${node.col}] Campo '${node.structName}.${f.name}' espera '${expected}', recebeu '${actual}'`);
          }
        }
        for (const reqField of fieldMap.keys()) {
          if (!provided.has(reqField)) {
            errors.push(`[${node.line}:${node.col}] Campo obrigatório '${reqField}' ausente na struct '${node.structName}'`);
          }
        }
        return node.structName;
      }
      case 'IndexExpr': {
        const targetType = inferExpr(node.target, scope);
        const idxType = inferExpr(node.index, scope);
        if (idxType && idxType !== 'u64' && idxType !== 'i64') {
          errors.push(`[${node.line}:${node.col}] Índice de array deve ser inteiro, recebeu '${idxType}'`);
        }
        const arrInfo = parseArrayType(targetType);
        if (targetType && !arrInfo) {
          errors.push(`[${node.line}:${node.col}] Indexação '[]' exige array, recebeu '${targetType}'`);
          return null;
        }
        if (arrInfo && node.index.type === 'IntLiteral' && Number(node.index.value) >= arrInfo.size) {
          errors.push(`[${node.line}:${node.col}] Índice ${node.index.value} fora dos limites do array [0..${arrInfo.size - 1}]`);
        }
        if (node.index.type === 'UnaryExpr' && node.index.op === '-') {
          errors.push(`[${node.line}:${node.col}] Índice negativo bloqueado por segurança de memória`);
        }
        return arrInfo ? arrInfo.elemType : null;
      }
      case 'MemberExpr': {
        if (node.target && node.target.type === 'IdentExpr' && enumTable.has(node.target.name)) {
          const variants = enumTable.get(node.target.name);
          if (!variants.has(node.field)) {
            errors.push(`[${node.line}:${node.col}] Variante '${node.field}' não existe no enum '${node.target.name}'`);
            return null;
          }
          return node.target.name;
        }
        const targetType = inferExpr(node.target, scope);
        if (!targetType) return null;
        const fieldMap = structTable.get(targetType);
        if (!fieldMap) {
          errors.push(`[${node.line}:${node.col}] Acesso '.${node.field}' inválido no tipo '${targetType}'`);
          return null;
        }
        if (!fieldMap.has(node.field)) {
          errors.push(`[${node.line}:${node.col}] Campo '${node.field}' não existe na struct '${targetType}'`);
          return null;
        }
        return fieldMap.get(node.field);
      }
      default:
        return null;
    }
  }

  let loopDepth = 0;

  function verifyBlock(block, parentScope, fnMeta, policy) {
    const scope = new Map(parentScope);
    for (const stmt of block.stmts || []) {
      verifyStmt(stmt, scope, fnMeta, policy);
    }
  }

  function verifyStmt(stmt, scope, fnMeta, policy) {
    switch (stmt.type) {
      case 'LetStmt': {
        const initType = inferExpr(stmt.init, scope);
        const resolvedType = stmt.varType || initType;
        if (!resolvedType) {
          errors.push(`[${stmt.line}:${stmt.col}] Não foi possível inferir o tipo de '${stmt.name}'`);
          return;
        }
        if (stmt.varType && initType && !compatType(stmt.varType, initType)) {
          errors.push(`[${stmt.line}:${stmt.col}] Variável '${stmt.name}' espera '${stmt.varType}', recebeu '${initType}'`);
        }
        scope.set(stmt.name, { type: resolvedType, isConst: false });
        break;
      }
      case 'AssignStmt': {
        if (constTable.has(stmt.name)) {
          errors.push(`[${stmt.line}:${stmt.col}] Não é permitido reatribuir constante '${stmt.name}'`);
          return;
        }
        if (!scope.has(stmt.name)) {
          errors.push(`[${stmt.line}:${stmt.col}] Variável '${stmt.name}' não declarada antes da atribuição`);
          return;
        }
        const expected = scope.get(stmt.name).type;
        const valType = inferExpr(stmt.value, scope);
        if (valType && !compatType(expected, valType)) {
          errors.push(`[${stmt.line}:${stmt.col}] Atribuição incompatível para '${stmt.name}': espera '${expected}', recebeu '${valType}'`);
        }
        break;
      }
      case 'IndexAssignStmt': {
        if (!scope.has(stmt.name)) {
          errors.push(`[${stmt.line}:${stmt.col}] Array '${stmt.name}' não declarado`);
          return;
        }
        const arrInfo = parseArrayType(scope.get(stmt.name).type);
        if (!arrInfo) {
          errors.push(`[${stmt.line}:${stmt.col}] Variável '${stmt.name}' não é um array`);
          return;
        }
        const idxType = inferExpr(stmt.index, scope);
        if (idxType && idxType !== 'u64' && idxType !== 'i64') {
          errors.push(`[${stmt.line}:${stmt.col}] Índice de array deve ser inteiro`);
        }
        if (stmt.index.type === 'IntLiteral' && Number(stmt.index.value) >= arrInfo.size) {
          errors.push(`[${stmt.line}:${stmt.col}] Índice ${stmt.index.value} fora dos limites do array [0..${arrInfo.size - 1}]`);
        }
        if (stmt.index.type === 'UnaryExpr' && stmt.index.op === '-') {
          errors.push(`[${stmt.line}:${stmt.col}] Índice negativo bloqueado por segurança de memória`);
        }
        const valType = inferExpr(stmt.value, scope);
        if (valType && !typesCompatible(arrInfo.elemType, valType)) {
          errors.push(`[${stmt.line}:${stmt.col}] Atribuição em '${stmt.name}[]' espera '${arrInfo.elemType}', recebeu '${valType}'`);
        }
        break;
      }
      case 'MemberAssignStmt': {
        if (!scope.has(stmt.name)) {
          errors.push(`[${stmt.line}:${stmt.col}] Struct '${stmt.name}' não declarada`);
          return;
        }
        const stName = scope.get(stmt.name).type;
        const fieldMap = structTable.get(stName);
        if (!fieldMap || !fieldMap.has(stmt.field)) {
          errors.push(`[${stmt.line}:${stmt.col}] Campo '${stmt.field}' não existe em '${stName}'`);
          return;
        }
        const expected = fieldMap.get(stmt.field);
        const valType = inferExpr(stmt.value, scope);
        if (valType && !typesCompatible(expected, valType)) {
          errors.push(`[${stmt.line}:${stmt.col}] Campo '${stmt.name}.${stmt.field}' espera '${expected}', recebeu '${valType}'`);
        }
        break;
      }
      case 'ReturnStmt': {
        const valType = stmt.value ? inferExpr(stmt.value, scope) : 'void';
        if (fnMeta.returnType === 'void' && stmt.value) {
          errors.push(`[${stmt.line}:${stmt.col}] Função void '${fnMeta.name}' não pode retornar valor`);
        } else if (fnMeta.returnType !== 'void' && !stmt.value) {
          errors.push(`[${stmt.line}:${stmt.col}] Função '${fnMeta.name}' deve retornar '${fnMeta.returnType}'`);
        } else if (valType && !compatType(fnMeta.returnType, valType)) {
          errors.push(`[${stmt.line}:${stmt.col}] Retorno incompatível em '${fnMeta.name}': espera '${fnMeta.returnType}', recebeu '${valType}'`);
        }
        break;
      }
      case 'IfStmt': {
        const condType = inferExpr(stmt.test, scope);
        if (condType && condType !== 'bool') {
          errors.push(`[${stmt.line}:${stmt.col}] Condição de 'if' deve ser 'bool', recebeu '${condType}'`);
        }
        verifyBlock(stmt.consequent, scope, fnMeta, policy);
        if (stmt.alternate) {
          if (stmt.alternate.type === 'Block') verifyBlock(stmt.alternate, scope, fnMeta, policy);
          else verifyStmt(stmt.alternate, scope, fnMeta, policy);
        }
        break;
      }
      case 'WhileStmt': {
        const condType = inferExpr(stmt.test, scope);
        if (condType && condType !== 'bool') {
          errors.push(`[${stmt.line}:${stmt.col}] Condição de 'while' deve ser 'bool', recebeu '${condType}'`);
        }
        if (!policy.max_loops && !(policy.daemon && policy.allow_network) && stmt.test.type === 'BoolLiteral' && stmt.test.value === true) {
          errors.push(`[${stmt.line}:${stmt.col}] Loop infinito 'while true' exige @policy(max_loops=N)`);
        }
        loopDepth += 1;
        verifyBlock(stmt.body, scope, fnMeta, policy);
        loopDepth -= 1;
        break;
      }
      case 'ForStmt': {
        const st = inferExpr(stmt.start, scope);
        const et = inferExpr(stmt.end, scope);
        if (st && !isNumericType(st)) errors.push(`[${stmt.line}:${stmt.col}] Início de 'for' deve ser numérico`);
        if (et && !isNumericType(et)) errors.push(`[${stmt.line}:${stmt.col}] Fim de 'for' deve ser numérico`);
        const loopScope = new Map(scope);
        loopScope.set(stmt.iter, { type: 'u64', isConst: false });
        loopDepth += 1;
        verifyBlock(stmt.body, loopScope, fnMeta, policy);
        loopDepth -= 1;
        break;
      }
      case 'MatchStmt': {
        const subjType = inferExpr(stmt.subject, scope);
        let hasWildcard = false;
        for (const arm of stmt.arms || []) {
          if (arm.isWildcard) hasWildcard = true;
          for (const pat of arm.patterns || []) {
            const patType = inferExpr(pat, scope);
            if (subjType && patType && !compatType(subjType, patType)) {
              errors.push(`[${stmt.line}:${stmt.col}] Padrão '${patType}' incompatível com 'match' de tipo '${subjType}'`);
            }
          }
          verifyBlock(arm.body, scope, fnMeta, policy);
        }
        if (!hasWildcard && subjType && enumTable.has(subjType)) {
          // Opcional: verificar exaustividade de enum se não houver '_'
          const covered = new Set();
          for (const arm of stmt.arms || []) {
            for (const pat of arm.patterns || []) {
              if (pat.type === 'MemberExpr' && pat.target && pat.target.name === subjType) {
                covered.add(pat.field);
              }
            }
          }
          const allVariants = Array.from(enumTable.get(subjType).keys());
          const missing = allVariants.filter((v) => !covered.has(v));
          if (missing.length > 0) {
            errors.push(`[${stmt.line}:${stmt.col}] 'match' no enum '${subjType}' não é exaustivo (faltam: ${missing.join(', ')}) — adicione os casos ou '_ => { ... }'`);
          }
        }
        break;
      }
      case 'BreakStmt':
      case 'ContinueStmt': {
        if (loopDepth <= 0) {
          errors.push(`[${stmt.line}:${stmt.col}] '${stmt.type === 'BreakStmt' ? 'break' : 'continue'}' só pode ser usado dentro de um loop 'while' ou 'for'`);
        }
        break;
      }
      case 'ExprStmt': {
        inferExpr(stmt.expr, scope);
        break;
      }
      default:
        break;
    }
  }

  function stmtAlwaysReturns(stmt) {
    if (!stmt) return false;
    if (stmt.type === 'ReturnStmt') return true;
    if (stmt.type === 'Block') return blockAlwaysReturns(stmt);
    if (stmt.type === 'IfStmt') {
      return Boolean(stmt.alternate) && blockAlwaysReturns(stmt.consequent) && stmtAlwaysReturns(stmt.alternate);
    }
    if (stmt.type === 'MatchStmt') {
      const arms = stmt.arms || [];
      if (arms.length === 0) return false;
      const hasDefault = arms.some((a) => a.isWildcard);
      return hasDefault && arms.every((a) => blockAlwaysReturns(a.body));
    }
    return false;
  }

  function blockAlwaysReturns(block) {
    if (!block || !Array.isArray(block.stmts)) return false;
    for (const s of block.stmts) {
      if (stmtAlwaysReturns(s)) return true;
    }
    return false;
  }

  for (const fn of ast.functions || []) {
    const fnScope = new Map();
    for (const p of fn.params) {
      fnScope.set(p.name, { type: p.paramType, isConst: false });
    }
    const effectivePolicy = Object.assign({ max_loops: 1000000 }, modulePolicy, fn.policy || {});
    activePolicy = effectivePolicy;
    verifyBlock(fn.body, fnScope, fn, effectivePolicy);
    if (fn.returnType !== 'void' && !blockAlwaysReturns(fn.body)) {
      errors.push(`[${fn.line}:${fn.col}] Função '${fn.name}' com retorno '${fn.returnType}' nem sempre retorna um valor em todos os caminhos`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    policy: modulePolicy
  };
}

module.exports = { verify, BUILTINS, FORBIDDEN_CALLS };
