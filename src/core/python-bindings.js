'use strict';
const UNKNOWN = { kind: 'unknown' };
const field = (n, name) => n.childForFieldName(name);
const literal = (n) => n?.type === 'string' && /^(['"])[^\\\r\n]*\1$/.test(n.text) ? n.text.slice(1, -1) : null;

function analyzePythonBindings(root, ir) {
  const model = { python: true, scopes: [{ parent: null, names: new Map() }], exports: new Map(), calls: [], classes: [], mutatedMembers: new Set() };
  const units = new Map(ir.units.map((unit) => [unit.start, unit]));
  const redirected = [];
  const scope = (parent) => { model.scopes.push({ parent, names: new Map() }); return model.scopes.length - 1; };
  const bind = (at, name, value) => {
    const names = model.scopes[at].names;
    names.set(name, names.has(name) ? UNKNOWN : value);
  };
  const expr = (node, at, self) => {
    if (!node) return UNKNOWN;
    if (node.type === 'identifier') return { kind: 'name', name: node.text, scope: at };
    if (literal(node) !== null) return { kind: 'literal', value: literal(node) };
    if (node.type === 'attribute') return { kind: 'member', object: expr(field(node, 'object'), at, self), name: field(node, 'attribute')?.text };
    if (node.type === 'subscript') return { kind: 'member', object: expr(field(node, 'value'), at, self), key: expr(field(node, 'subscript'), at, self) };
    if (node.type === 'call') {
      const fn = field(node, 'function'), args = field(node, 'arguments');
      if (fn?.text === 'super' && args?.namedChildCount === 0 && self) return { kind: 'super', self, builtin: 'super', scope: at };
      if (fn?.text === 'getattr' && args?.namedChildCount === 2) return { kind: 'member', object: expr(args.namedChild(0), at, self), key: expr(args.namedChild(1), at, self), builtin: 'getattr', scope: at };
      return { kind: 'python-instance', cls: expr(fn, at, self) };
    }
    if (node.type === 'dictionary') {
      const members = new Map();
      for (const pair of node.namedChildren) {
        const key = literal(field(pair, 'key'));
        if (key === null) return UNKNOWN;
        members.set(key, expr(field(pair, 'value'), at, self));
      }
      return { kind: 'object', members };
    }
    return UNKNOWN;
  };
  const pattern = (node, at, value = UNKNOWN) => {
    if (!node) return;
    if (node.type === 'identifier') bind(at, node.text, value);
    else if (node.type === 'default_parameter' || node.type === 'typed_default_parameter') pattern(field(node, 'name'), at);
    else if (node.type === 'typed_parameter') pattern(node.namedChild(0), at);
    else for (const child of node.namedChildren) pattern(child, at);
  };
  const visit = (node, at, owner, self, cls, depth = 0) => {
    if (depth > 1200) throw new Error('binding-depth-limit');
    const type = node.type;
    if (type === 'class_definition') {
      const bases = field(node, 'superclasses')?.namedChildren || [];
      const ref = { kind: 'class', python: true, id: ir.rel + ':class:' + node.startIndex, base: bases.length === 1 ? expr(bases[0], at, self) : null, methods: new Map(), statics: new Map() };
      bind(at, field(node, 'name').text, ref); model.classes.push(ref);
      const body = field(node, 'body');
      for (const child of body?.namedChildren || []) {
        const assignment = child.type === 'expression_statement' ? child.namedChild(0) : child;
        if (assignment?.type === 'assignment' && field(assignment, 'left')?.type === 'identifier') {
          ref.methods.set(field(assignment, 'left').text, UNKNOWN);
          continue;
        }
        const fn = child.type === 'decorated_definition' ? field(child, 'definition') : child;
        if (fn?.type !== 'function_definition') continue;
        const unit = units.get(fn.startIndex), name = field(fn, 'name').text;
        const refFn = unit ? { kind: 'function', id: unit.id } : UNKNOWN;
        const decorated = child.type === 'decorated_definition';
        const decorators = decorated ? child.namedChildren.filter((n) => n.type === 'decorator').map((n) => n.text) : [];
        const supported = decorators.every((text) => text === '@staticmethod' || text === '@classmethod');
        const table = decorators.length ? ref.statics : ref.methods;
        table.set(name, table.has(name) || !supported ? UNKNOWN : refFn);
      }
      for (const child of body?.namedChildren || []) visit(child, scope(at), owner, null, ref, depth + 1);
      return;
    }
    if (type === 'function_definition') {
      const unit = units.get(node.startIndex), target = unit ? { kind: 'function', id: unit.id } : UNKNOWN;
      if (!cls) bind(at, field(node, 'name').text, node.parent.type === 'decorated_definition' ? UNKNOWN : target);
      const inner = scope(at), params = field(node, 'parameters');
      for (const param of params?.namedChildren || []) pattern(param, inner);
      const decorators = node.parent?.type === 'decorated_definition' ? node.parent.namedChildren.filter((n) => n.type === 'decorator').map((n) => n.text) : [];
      let methodSelf = null;
      if (cls && !decorators.includes('@staticmethod')) {
        methodSelf = decorators.includes('@classmethod') ? { ...cls, polymorphic: true } : { kind: 'instance', cls, polymorphic: true };
        const first = params?.namedChild(0);
        if (first?.type === 'identifier') model.scopes[inner].names.set(first.text, methodSelf);
      }
      const body = field(node, 'body');
      if (body) visit(body, inner, unit?.id || null, methodSelf, null, depth + 1);
      return;
    }
    if (type === 'lambda') return;
    if (type === 'as_pattern') pattern(field(node, 'alias'), at);
    if (['list_comprehension', 'dictionary_comprehension', 'set_comprehension', 'generator_expression'].includes(type)) at = scope(at);
    if (type === 'global_statement' || type === 'nonlocal_statement') {
      for (const child of node.namedChildren) if (child.type === 'identifier') redirected.push({ scope: at, name: child.text, global: type === 'global_statement' });
    }
    if (type === 'assignment' || type === 'augmented_assignment') {
      const left = field(node, 'left');
      if (left?.type === 'attribute') model.mutatedMembers.add(field(left, 'attribute').text);
      else if (left?.type === 'subscript') model.mutatedMembers.add(literal(field(left, 'subscript')) ?? '*');
      else pattern(left, at, type === 'assignment' ? expr(field(node, 'right'), at, self) : UNKNOWN);
    }
    if (type === 'for_statement' || type === 'for_in_clause') pattern(field(node, 'left'), at);
    if (type === 'import_statement' || type === 'import_from_statement') {
      const from = field(node, 'module_name')?.text;
      for (const child of node.namedChildren) {
        if (child.startIndex === field(node, 'module_name')?.startIndex || child.type === 'relative_import') continue;
        const original = child.type === 'aliased_import' ? field(child, 'name')?.text : child.text;
        const alias = field(child, 'alias')?.text || original;
        if (!original || !alias || original === '*') continue;
        bind(at, alias, from ? { kind: 'import', spec: from, name: original, python: true }
          : { kind: 'import', spec: original, name: '*' });
      }
    }
    if (type === 'call') model.calls.push({ owner, line: node.startPosition.row + 1, ref: expr(field(node, 'function'), at, self), python: true });
    for (const child of node.namedChildren) visit(child, at, owner, self, cls, depth + 1);
  };
  visit(root, 0, ir.rel + '#<módulo>', null, null);
  for (const entry of redirected) {
    let at = entry.global ? 0 : model.scopes[entry.scope].parent;
    while (at !== null && !model.scopes[at].names.has(entry.name)) at = model.scopes[at].parent;
    if (at !== null) model.scopes[at].names.set(entry.name, UNKNOWN);
  }
  for (const name of model.scopes[0].names.keys()) model.exports.set(name, { kind: 'name', name, scope: 0 });
  return model;
}

module.exports = { analyzePythonBindings };
