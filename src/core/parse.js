'use strict';
// Adaptador de lenguaje -> IR universal. Un solo recorrido del árbol de tree-sitter por archivo.
// Los conjuntos de tipos son globales: cada gramática usa nombres distintos, así que la unión no colisiona.
const path = require('path');
const vm = require('vm');
const Parser = require('web-tree-sitter');
const { analyzeBindings } = require('./bindings');
const { analyzePythonBindings } = require('./python-bindings');

const set = (s) => new Set(s.split(/\s+/).filter(Boolean));
const FUNC = set(`function_declaration generator_function_declaration method_definition function_definition method_declaration
  constructor_declaration function_item method singleton_method arrow_function function_expression function func_literal
  local_function_statement generator_function lambda init_declaration lambda_literal anonymous_function`);
const CLASS = set(`class_declaration class_definition class interface_declaration struct_item impl_item trait_item module
  abstract_class_declaration enum_declaration record_declaration struct_declaration protocol_declaration object_declaration`);
const CALL = set(`call_expression call method_invocation invocation_expression function_call_expression member_call_expression
  scoped_call_expression nullsafe_member_call_expression`);
const LOOP = set(`for_statement for_in_statement for_of_statement while_statement do_statement foreach_statement for_expression
  while_expression loop_expression enhanced_for_statement for while until for_each_statement repeat_while_statement do_while_statement`);
const BRANCH = set(`if_statement elif_clause else_if_clause switch_case case_clause catch_clause except_clause ternary_expression
  conditional_expression match_arm if_expression if elsif unless when rescue switch_section case_statement expression_case
  type_case communication_case switch_label conditional_access_expression guard_statement switch_entry catch_block when_entry`);
const IMPORT = set(`import_statement import_from_statement import_spec import_declaration import_header using_directive use_declaration
  namespace_use_declaration mod_item include_expression require_expression require_once_expression include_once_expression`);
const COMPARE = set('binary_expression comparison_operator binary comparison_expression equality_expression');
const ASSIGN = set(`variable_declarator assignment const_spec const_item const_element assignment_expression
  augmented_assignment static_item short_var_declaration property_declaration`);
const TERMINATOR = set('return_statement throw_statement raise_statement break_statement continue_statement control_transfer_statement jump_expression');
const BLOCK = set('statement_block block compound_statement body_statement statements');
const CATCH = set('catch_clause except_clause rescue catch_block');

const LOGICAL = new Set(['&&', '||', '??', 'and', 'or']);
const CMP_OPS = new Set(['>=', '<=', '>', '<', '==', '===', '!=', '!==']);
const FLIP = { '>=': '<=', '<=': '>=', '>': '<', '<': '>' };
const IDENT_RE = /identifier|^name$|^constant$/;
const NUM_TYPE_RE = /number|integer|float|int_literal|decimal|real_literal/;
const STR_TYPE_RE = /^string$|string_fragment|string_content|escape_sequence|string_literal|heredoc|str_text/;
const ASSERT_RE = /^(assert|expect|should|verify|XCTAssert|XCTFail|Errorf?|Fatalf?|FailNow)/;
const QUERY_RE = /^(query|execute|exec|find|findOne|findAll|findById|findBy\w+|fetch|select|get\w*ById|request|save|insert|update|delete|aggregate|count)$/i;
const RULE_NAME_RE = /(max|min|limit|timeout|ttl|threshold|retr|expir|age|rate|fee|price|tax|discount|quota|attempt|enabled|allow|duration|interval|length|size|days|hours|minutes)/i;
const NOISE_NAME_RE = /^(i|j|k|n|x|y|idx|index|length|size|count|len|argc|status|statusCode|code|err|errno|result|res|ret|rc|pos|offset|depth|level)$/i;
const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b[:\s-]*(.{0,120})/;
const NUM_RE = /^-?\d[\d_]*(\.\d+)?$/;

let initPromise;
const languages = new Map();
async function getLanguage(name) {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
  if (!languages.has(name)) {
    const wasm = path.join(__dirname, '..', '..', 'grammars', `tree-sitter-${name}.wasm`);
    languages.set(name, Parser.Language.load(wasm).catch(() => null));
  }
  return languages.get(name);
}

/** Internado de tokens compartido por todo el motor (para detectar duplicación con enteros). */
class Interner {
  constructor() { this.map = new Map(); this.values = [null]; }
  id(s) { let v = this.map.get(s); if (v === undefined) { v = this.map.size + 1; this.map.set(s, v); this.values.push(s); } return v; }
}

function lastName(text) {
  const m = /([A-Za-z_$][\w$]*)\s*[?!]?$/.exec(text);
  return m ? m[1] : null;
}

function funcName(node) {
  const n = node.childForFieldName('name');
  if (n) return lastName(n.text);
  if (node.type === 'function_declaration') { // gramáticas sin campos con nombre (Kotlin)
    const id = node.namedChildren.find((c) => c.type === 'simple_identifier' || c.type === 'identifier');
    if (id) return lastName(id.text);
  }
  const p = node.parent;
  if (!p) return null;
  if (/^(variable_declarator|pair|assignment_expression|public_field_definition|field_definition|property_definition|assignment)$/.test(p.type)) {
    const k = p.childForFieldName('name') || p.childForFieldName('key') || p.childForFieldName('left') || p.childForFieldName('property');
    if (k && k.endIndex <= node.startIndex) return lastName(k.text);
  }
  return null;
}

function calleeName(node) {
  let n = node.childForFieldName('function') || node.childForFieldName('name') || node.childForFieldName('method')
    || node.childForFieldName('constructor') || node.childForFieldName('type') || node.namedChild(0); // Swift/Kotlin: el primer hijo es lo llamado
  if (!n) return null;
  for (let guard = 0; guard < 6 && n.namedChildCount > 0; guard++) {
    n = n.childForFieldName('property') || n.childForFieldName('attribute') || n.childForFieldName('field')
      || n.childForFieldName('name') || n.childForFieldName('suffix') || n.lastNamedChild;
    if (!n) return null;
  }
  const t = n.text;
  return t.length <= 60 && /^[A-Za-z_$][\w$]*[?!]?$/.test(t) ? t : null;
}

function isExported(lang, node, name, source) {
  switch (lang) {
    case 'javascript': case 'typescript': case 'tsx': {
      let p = node.parent;
      for (let i = 0; i < 4 && p; i++, p = p.parent) if (p.type === 'export_statement') return true;
      return false;
    }
    case 'python': return !name.startsWith('_') && node.parent && /^(module|decorated_definition)$/.test(node.parent.type);
    case 'go': return /^[A-Z]/.test(name);
    case 'rust': return /^\s*pub\b/.test(source.slice(node.startIndex, node.startIndex + 12));
    case 'java': case 'c_sharp': case 'php':
      return /\bpublic\b/.test(source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 200)).split(/[({]/)[0]);
    case 'swift': case 'kotlin':
      return !/\b(private|fileprivate)\b/.test(source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 120)).split(/[({]/)[0]);
    default: return true;
  }
}

function importSpecs(lang, text) {
  const out = [];
  const quoted = () => { const m = /['"`]([^'"`\n]+)['"`]/.exec(text); if (m) out.push(m[1]); };
  if (lang === 'javascript' || lang === 'typescript' || lang === 'tsx') {
    const m = /from\s*['"]([^'"]+)['"]/.exec(text) || /^import\s*['"]([^'"]+)['"]/.exec(text);
    if (m) out.push(m[1]);
  } else if (lang === 'python') {
    let m = /^from\s+([.\w]+)\s+import\s+([\s\S]+)$/.exec(text);
    if (m) {
      out.push(m[1]);
      const sep = m[1].endsWith('.') ? '' : '.';
      for (const nm of m[2].replace(/[()]/g, '').split(',')) {
        const id = nm.trim().split(/\s+as\s+/)[0].trim();
        if (/^\w+$/.test(id)) out.push({ spec: m[1] + sep + id, optional: true });
      }
    } else if ((m = /^import\s+(.+)$/.exec(text))) {
      for (const nm of m[1].split(',')) out.push(nm.trim().split(/\s+as\s+/)[0].trim());
    }
  } else if (lang === 'go') quoted();
  else if (lang === 'kotlin') { const m = /import\s+([\w.]+)/.exec(text); if (m) out.push(m[1].replace(/\.\*$/, '')); }
  else if (lang === 'swift') { /* los imports de Swift son de módulos, no de archivos */ }
  else if (lang === 'java') { const m = /import\s+(?:static\s+)?([\w.]+)/.exec(text); if (m) out.push(m[1].replace(/\.\*$/, '')); }
  else if (lang === 'c_sharp') { const m = /using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)/.exec(text); if (m) out.push(m[1]); }
  else if (lang === 'rust') {
    let m = /^(?:pub\s+)?mod\s+(\w+)\s*;/.exec(text);
    if (m) out.push('./' + m[1]);
    else if ((m = /use\s+((?:crate|super|self)(?:::\w+)+)/.exec(text))) out.push(m[1]);
  } else if (lang === 'php') {
    if (/^(require|include)/.test(text)) quoted();
    else { const m = /use\s+(?:function\s+|const\s+)?([\w\\]+)/.exec(text); if (m) out.push(m[1]); }
  }
  return out.map((s) => (typeof s === 'string' ? { spec: s } : s));
}

function statementName(raw) {
  let t = raw.replace(/\s+/g, '');
  const len = /^len\(([\w.]+)\)$/.exec(t);
  if (len) return lastName(len[1]) + '.length';
  t = t.replace(/^(this|self|\$this)(\.|->)/, '').replace(/\(\)$/, '').replace(/->|::/g, '.').replace(/^\$/, '');
  if (!/^[A-Za-z_][\w.]*$/.test(t)) return null;
  const parts = t.split('.');
  let name = parts[parts.length - 1];
  if (/^(length|size|count|len|value|total|amount)$/i.test(name) && parts.length > 1) name = parts[parts.length - 2] + '.' + name;
  return name;
}

function literalValue(text) {
  const t = text.trim();
  if (NUM_RE.test(t)) return Number(t.replace(/_/g, ''));
  if (/^(true|True)$/.test(t)) return true;
  if (/^(false|False)$/.test(t)) return false;
  const s = /^(['"])([^'"\n]{1,40})\1$/.exec(t);
  return s ? s[2] : undefined;
}

/**
 * @returns IR del archivo: unidades (funciones), imports, tokens, statements y hallazgos locales.
 */
async function parseFile(file, source, interner) {
  const lang = await getLanguage(file.lang);
  const ir = {
    rel: file.rel, lang: file.lang, isTest: file.isTest, lines: 0, units: [], imports: [], idents: new Map(),
    tokens: null, tokenLines: null, statements: [], local: [], todos: [], hasAssert: false, classes: [], parsed: false,
  };
  const lineStarts = [0];
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  ir.lines = lineStarts.length;
  const lineAt = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const lineText = (line) => source.slice(lineStarts[line - 1], lineStarts[line] ?? source.length).trim().slice(0, 160);
  if (!lang) return ir;
  // Código minificado o generado: no aporta y dispara falsos positivos.
  if (source.length / lineStarts.length > 300) { ir.skipped = 'minificado'; return ir; }

  const parser = new Parser();
  let tree;
  try { parser.setLanguage(lang); tree = parser.parse(source); } catch { parser.delete(); return ir; }
  ir.parsed = true;

  const moduleUnit = { id: file.rel + '#<módulo>', name: '<módulo>', module: true, line: 1, endLine: ir.lines, cx: 0, calls: new Set(), refs: new Set() };
  const stack = [moduleUnit];
  const classStack = [];
  const usedIds = new Set();
  const toks = [], tokLines = [];
  let loop = 0, nest = 0, depth = 0;
  const cur = tree.walk();
  const node = () => (typeof cur.currentNode === 'function' ? cur.currentNode() : cur.currentNode);
  const local = (rule, line, extra) => ir.local.push({ rule, line, ...extra });
  const isJs = file.lang === 'javascript' || file.lang === 'typescript' || file.lang === 'tsx';

  function onCompare(n, line, unit) {
    if (n.namedChildCount !== 2) return;
    const left = n.namedChild(0), right = n.namedChild(1);
    const op = source.slice(left.endIndex, right.startIndex).trim();
    if (!CMP_OPS.has(op)) return;
    const lt = left.text, rt = right.text;
    if (lt === rt && lt.length < 80 && !/[!]/.test(op) && !NUM_RE.test(lt) && /^[\w.$\[\]]+$/.test(lt)) {
      local('self-compare', line, { code: lineText(line), symbol: lt, nanIdiom: op === '===' || op === '==' });
      return;
    }
    let nameText, valText, o = op;
    if (NUM_RE.test(rt)) { nameText = lt; valText = rt; }
    else if (NUM_RE.test(lt)) { nameText = rt; valText = lt; o = FLIP[op] || op; }
    else return;
    if (nameText.length > 60 || (n.parent && /^for/.test(n.parent.type))) return;
    const name = statementName(nameText);
    if (!name || name.length < 3 || NOISE_NAME_RE.test(name)) return;
    const value = Number(valText.replace(/_/g, ''));
    if ((value === 0 || value === 1 || value === -1) && !RULE_NAME_RE.test(name)) return;
    ir.statements.push({ kind: 'regla', name, op: o.replace('===', '==').replace('!==', '!='), value, line, unit: unit.name, code: lineText(line) });
  }

  function onAssign(n, line, unit) {
    const nameNode = n.childForFieldName('name') || n.childForFieldName('left') || n.namedChildren.find((c) => c.type === 'variable_declaration') || n.namedChild(0);
    const valNode = n.childForFieldName('value') || n.childForFieldName('right') || n.lastNamedChild;
    if (!nameNode || !valNode || nameNode === valNode || valNode.endIndex - valNode.startIndex > 44) return;
    const name = nameNode.text.replace(/^\$/, '').split(/[\s:]/)[0];
    if (!/^[A-Za-z_]\w{2,}$/.test(name)) return;
    const upper = /^[A-Z][A-Z0-9_]{2,}$/.test(name);
    if (!upper && !(RULE_NAME_RE.test(name) && (unit.module || n.type === 'const_spec'))) return;
    const value = literalValue(valNode.text);
    if (value === undefined) return;
    ir.statements.push({ kind: 'constante', name, op: '=', value, line, unit: unit.name, code: lineText(line) });
  }

  function onTerminator(n, line) {
    const parent = n.parent;
    if (!parent || !BLOCK.has(parent.type)) return;
    let sib = n.nextNamedSibling;
    while (sib && /comment/.test(sib.type)) sib = sib.nextNamedSibling;
    if (!sib || (parent.type !== 'statements' && !/(_statement|_declaration|^expression_statement)$/.test(sib.type))) return;
    if (/^(function_declaration|class_declaration|empty_statement|labeled_statement)$/.test(sib.type)) return;
    local('unreachable', lineAt(sib.startIndex), { code: lineText(lineAt(sib.startIndex)), after: lineText(line) });
  }

  function onCatch(n, line) {
    if (n.type === 'catch_block') { // Swift/Kotlin: vacío si no contiene sentencias
      if (!n.namedChildren.some((c) => c.type === 'statements')) local('empty-catch', line, { code: lineText(line) });
      return;
    }
    const body = n.childForFieldName('body') || n.lastNamedChild;
    if (!body || !BLOCK.has(body.type)) return;
    const kids = body.namedChildren;
    if (kids.length === 0 || (kids.length === 1 && kids[0].type === 'pass_statement')) local('empty-catch', line, { code: lineText(line) });
  }

  function onObject(n) {
    const seen = new Set();
    for (const child of n.namedChildren) {
      if (child.type !== 'pair') continue;
      const k = child.childForFieldName('key');
      if (!k || k.type === 'computed_property_name') continue;
      const key = k.text.replace(/^['"]|['"]$/g, '');
      if (seen.has(key)) local('duplicate-key', lineAt(k.startIndex), { code: lineText(lineAt(k.startIndex)), symbol: key });
      seen.add(key);
    }
  }

  function visit() {
    const type = cur.nodeType;
    const named = cur.nodeIsNamed;
    const start = cur.startIndex;
    let pushedUnit = false, pushedClass = false, isFunc = false, savedLoop = 0, savedNest = 0, incLoop = false, incNest = false;
    const unit = stack[stack.length - 1];

    if (named) {
      if (FUNC.has(type)) {
        isFunc = true; savedLoop = loop; savedNest = nest; loop = 0; nest = 0;
        const n = node();
        const name = funcName(n);
        if (name) {
          const cls = classStack[classStack.length - 1] || null;
          const line = lineAt(start);
          let id = `${file.rel}#${cls ? cls + '.' : ''}${name}`;
          if (usedIds.has(id)) id += '@' + line;
          if (usedIds.has(id)) id += ':' + start;
          usedIds.add(id);
          const params = n.childForFieldName('parameters');
          const head = source.slice(start, start + 1);
          const prev = n.previousNamedSibling;
          const u = {
            id, name, cls, line, endLine: lineAt(n.endIndex - 1), start, end: n.endIndex, cx: 1, maxNest: 0,
            params: params ? params.namedChildren.filter((p) => !/^(self|cls)$/.test(p.text) && !/comment/.test(p.type)).length
              : (n.namedChildren.find((c) => c.type === 'function_value_parameters') || n).namedChildren.filter((c) => c.type === 'parameter').length,
            calls: new Set(), callSites: [], parentId: unit.id, refs: new Set(), flags: {},
            exported: cls ? !/^[_#]/.test(name) : isExported(file.lang, n, name, source),
            topLevel: !cls && stack.length === 1,
            decorated: head === '@' || head === '[' || (prev && prev.type === 'decorator') || (n.parent && n.parent.type === 'decorated_definition'),
          };
          ir.units.push(u); stack.push(u); pushedUnit = true;
        }
      } else if (CLASS.has(type)) {
        const n = node();
        const nm = n.childForFieldName('name') || n.childForFieldName('type') || n.namedChildren.find((c) => c.type === 'type_identifier' || c.type === 'simple_identifier');
        if (nm) { classStack.push(lastName(nm.text) || nm.text); ir.classes.push(classStack[classStack.length - 1]); pushedClass = true; }
      }
      const u = stack[stack.length - 1];
      if (BRANCH.has(type)) { u.cx++; nest++; incNest = true; if (nest > (u.maxNest || 0)) u.maxNest = nest; }
      if (LOOP.has(type)) {
        u.cx++; loop++; nest++; incLoop = true; incNest = true;
        if (nest > (u.maxNest || 0)) u.maxNest = nest;
        if (loop >= 3 && u.flags && !u.flags.nestedLoops) u.flags.nestedLoops = lineAt(start);
      }
      if (CALL.has(type)) {
        const n = node();
        const name = calleeName(n);
        if (name) {
          u.calls.add(name);
          const target = n.childForFieldName('function') || n.childForFieldName('name') || n.childForFieldName('method');
          const object = n.childForFieldName('object') || target?.childForFieldName('object') || target?.childForFieldName('expression');
          const head = source.slice(start, n.endIndex).split('(')[0].trim();
          const explicit = object?.text || (/^([\w$]+)[.:]+[\w$]+$/.exec(head) || [])[1];
          (u.callSites || (u.callSites = [])).push({ name, receiver: explicit || null, line: lineAt(start) });
          if (loop > 0 && u.flags && !u.flags.queryInLoop && QUERY_RE.test(name) && /\.|->/.test(source.slice(start, start + 80).split('(')[0])) {
            u.flags.queryInLoop = { line: lineAt(start), name };
          }
          if (name === 'require' || name === 'require_relative' || name === 'import') {
            const m = /^[\w.]+\s*\(?\s*['"]([^'"\n]+)['"]/.exec(source.slice(start, start + 200));
            if (m) ir.imports.push({ spec: name === 'require_relative' && !m[1].startsWith('.') ? './' + m[1] : m[1], line: lineAt(start) });
          }
        }
      } else if (type === 'await_expression') {
        if (loop > 0 && u.flags && !u.flags.awaitInLoop) u.flags.awaitInLoop = lineAt(start);
      } else if (IMPORT.has(type)) {
        const text = source.slice(start, Math.min(cur.endIndex, start + 600));
        for (const s of importSpecs(file.lang, text)) ir.imports.push({ ...s, line: lineAt(start) });
      } else if (type === 'export_statement') {
        const m = /\bfrom\s*['"]([^'"]+)['"]\s*;?\s*$/.exec(source.slice(start, Math.min(cur.endIndex, start + 600)));
        if (m) ir.imports.push({ spec: m[1], line: lineAt(start) });
      } else if (COMPARE.has(type)) onCompare(node(), lineAt(start), u);
      else if (TERMINATOR.has(type)) onTerminator(node(), lineAt(start));
      else if (type === 'object' || type === 'dictionary') onObject(node());
      else if (type === 'default_parameter' || type === 'typed_default_parameter') {
        if (file.lang === 'python' && /=\s*(\[\]|\{\}|set\(\)|list\(\)|dict\(\))\s*$/.test(source.slice(start, cur.endIndex))) {
          local('mutable-default', lineAt(start), { code: lineText(lineAt(start)) });
        }
      }
      if (ASSIGN.has(type)) onAssign(node(), lineAt(start), u);
      if (CATCH.has(type)) onCatch(node(), lineAt(start));
    }

    if (depth < 1500 && cur.gotoFirstChild()) {
      depth++;
      do { visit(); } while (cur.gotoNextSibling());
      cur.gotoParent();
      depth--;
    } else {
      // Hoja
      const end = cur.endIndex;
      if (/comment/.test(type)) {
        const m = TODO_RE.exec(source.slice(start, Math.min(end, start + 400)));
        if (m) ir.todos.push({ line: lineAt(start), tag: m[1], text: m[2].replace(/\*\/\s*$/, '').trim() });
      } else if (type === 'ERROR') {
        if (!ir.syntaxError) ir.syntaxError = lineAt(start);
      } else if (end > start) {
        const text = source.slice(start, end);
        let tok = text;
        if (named) {
          if (STR_TYPE_RE.test(type)) tok = '$S';
          else if (NUM_TYPE_RE.test(type)) tok = '$N';
          else if (IDENT_RE.test(type)) {
            ir.idents.set(text, (ir.idents.get(text) || 0) + 1);
            if (/^[A-Z][A-Z0-9_]{2,}$/.test(text) || RULE_NAME_RE.test(text)) stack[stack.length - 1].refs.add(text);
            if (!ir.hasAssert && ASSERT_RE.test(text)) ir.hasAssert = true;
          }
        } else if (LOGICAL.has(type)) stack[stack.length - 1].cx++;
        else if (type === 'assert') ir.hasAssert = true;
        toks.push(interner.id(tok)); tokLines.push(lineAt(start));
      }
    }

    if ((type === 'ERROR' || cur.nodeIsMissing) && !ir.syntaxError) ir.syntaxError = lineAt(start);
    if (incLoop) loop--;
    if (incNest) nest--;
    if (isFunc) { loop = savedLoop; nest = savedNest; }
    if (pushedUnit) stack.pop();
    if (pushedClass) classStack.pop();
  }

  try { visit(); } catch (e) { ir.parseError = String(e && e.message || e); ir.parsed = false; }
  if ((isJs || file.lang === 'python') && ir.parsed) {
    try { ir.bindings = (isJs ? analyzeBindings : analyzePythonBindings)(tree.rootNode, ir); }
    catch (e) { ir.parseError = String(e && e.message || e); ir.parsed = false; }
  }
  cur.delete(); tree.delete(); parser.delete();

  if (ir.syntaxError) {
    // Segunda opinión: para JavaScript se pregunta al propio motor (V8). Si lo acepta, era un falso positivo del parser.
    const line = ir.syntaxError;
    ir.syntaxError = { line };
    if (file.lang === 'javascript' && !/\.jsx$/.test(file.rel)) {
      try { new vm.Script(source.replace(/^#!.*/, ''), { filename: file.rel }); ir.syntaxError = null; }
      catch (e) {
        const msg = String(e && e.message);
        // En ESM/JSX, V8 en modo script no puede confirmar ni descartar el diagnóstico.
        if (!/import|export|await|Unexpected token '<'|outside a module/.test(msg)) ir.syntaxError.v8 = msg;
      }
    }
  }

  if (isJs) {
    // CommonJS: module.exports = { a, b } / exports.a = ...
    const names = new Set();
    for (const m of source.matchAll(/(?:module\.)?exports\.(\w+)\s*=/g)) names.add(m[1]);
    const obj = /module\.exports\s*=\s*\{([^}]*)\}/.exec(source);
    if (obj) for (const m of obj[1].matchAll(/(\w+)\s*(?:,|:|$)/g)) names.add(m[1]);
    const direct = /module\.exports\s*=\s*(\w+)/.exec(source);
    if (direct) names.add(direct[1]);
    for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) for (const n of m[1].matchAll(/(\w+)\s*(?:,|as\b|$)/g)) names.add(n[1]);
    // exportRefs: la mención en la lista de exportación no cuenta como «uso» al buscar código muerto.
    for (const u of ir.units) if (u.topLevel && names.has(u.name)) { u.exported = true; u.exportRefs = 1; }
  }
  moduleUnit.cx = 0;
  ir.moduleUnit = moduleUnit;
  ir.tokens = Int32Array.from(toks);
  ir.tokenLines = Int32Array.from(tokLines);
  return ir;
}

module.exports = { parseFile, Interner };
