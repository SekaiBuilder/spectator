'use strict';

// Resolución conservadora de valores JS/TS. Los casos dinámicos quedan sin resolver.
const FUNCTIONS = new Set(['function_declaration', 'generator_function_declaration', 'function_expression', 'generator_function', 'arrow_function', 'method_definition']);
const BLOCKS = new Set(['statement_block', 'for_statement', 'for_in_statement', 'catch_clause', 'switch_body']);
const UNKNOWN = { kind: 'unknown' };
const field = (node, name) => node.childForFieldName(name);
const literal = (node) => node?.type === 'string' && !node.text.includes('\\') ? node.text.slice(1, -1) : null;

function analyzeBindings(root, ir) {
  const model = { scopes: [{ parent: null, function: true, names: new Map() }], exports: new Map(), exportStars: [], calls: [], mutatedMembers: new Set(), classes: [] };
  const units = new Map(ir.units.map((u) => [u.start, u]));
  const writes = [];
  const commonExports = [];
  const scope = (parent, fn = false) => { model.scopes.push({ parent, function: fn, names: new Map() }); return model.scopes.length - 1; };
  const bind = (at, name, ref) => {
    if (!name) return;
    const names = model.scopes[at].names;
    names.set(name, names.has(name) ? UNKNOWN : ref);
  };
  const expression = (node, at, self) => {
    if (!node) return UNKNOWN;
    if (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'shorthand_property_identifier') return { kind: 'name', name: node.text, scope: at };
    if (node.type === 'this') return self || UNKNOWN;
    if (node.type === 'super') return self ? { kind: 'super', self } : UNKNOWN;
    if (node.type === 'string') return { kind: 'literal', value: literal(node) };
    if (FUNCTIONS.has(node.type)) {
      if (node.type === 'method_definition' && node.children.some((child) => child.type === 'get' || child.type === 'set')) return UNKNOWN;
      return units.has(node.startIndex) ? { kind: 'function', id: units.get(node.startIndex).id } : UNKNOWN;
    }
    if (node.type === 'parenthesized_expression' || node.type === 'as_expression' || node.type === 'non_null_expression') return expression(node.namedChild(0), at, self);
    if (node.type === 'member_expression') return { kind: 'member', object: expression(field(node, 'object'), at, self), name: field(node, 'property')?.text };
    if (node.type === 'subscript_expression') return { kind: 'member', object: expression(field(node, 'object'), at, self), key: expression(field(node, 'index'), at, self) };
    if (node.type === 'new_expression') return { kind: 'instance', cls: expression(field(node, 'constructor'), at, self) };
    if (node.type === 'call_expression' && field(node, 'function')?.text === 'require') {
      const args = field(node, 'arguments');
      const spec = args?.namedChildCount === 1 && literal(args.namedChild(0));
      if (spec) return { kind: 'require', spec, scope: at };
    }
    if (node.type === 'call_expression') {
      const callee = field(node, 'function');
      if (callee?.type === 'member_expression' && field(callee, 'property')?.text === 'bind') return { kind: 'bound', target: expression(field(callee, 'object'), at, self) };
    }
    if (node.type === 'object') {
      const members = new Map();
      for (const child of node.namedChildren) {
        const key = field(child, 'key') || field(child, 'name');
        if (child.type === 'spread_element') return UNKNOWN;
        const name = key ? literal(key) || key.text : child.text;
        members.set(name, child.type === 'pair' ? expression(field(child, 'value'), at, self) : expression(child, at, self));
      }
      return { kind: 'object', members };
    }
    return UNKNOWN;
  };
  const pattern = (node, at, ref = UNKNOWN) => {
    if (!node) return;
    if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') bind(at, node.text, ref);
    else if (node.type === 'object_pattern') {
      for (const child of node.namedChildren) {
        if (child.type === 'shorthand_property_identifier_pattern') bind(at, child.text, { kind: 'member', object: ref, name: child.text });
        else if (child.type === 'pair_pattern') pattern(field(child, 'value'), at, { kind: 'member', object: ref, name: field(child, 'key')?.text });
        else pattern(child, at);
      }
    } else if (node.type === 'assignment_pattern' || node.type === 'object_assignment_pattern') pattern(field(node, 'left'), at);
    else if (node.type === 'required_parameter' || node.type === 'optional_parameter') pattern(field(node, 'pattern') || node.namedChild(0), at);
    else for (const child of node.namedChildren) if (child.type !== 'type_annotation') pattern(child, at);
  };
  const visit = (node, at, owner, self, cls, depth = 0) => {
    if (depth > 1200) throw new Error('binding-depth-limit');
    const type = node.type;
    if (type === 'class_declaration' || type === 'class') {
      const heritage = node.namedChildren.find((child) => child.type === 'class_heritage');
      const extend = heritage?.namedChildren.find((child) => child.type === 'extends_clause');
      const base = field(extend || heritage || node, 'value') || (heritage?.namedChild(0)?.type !== 'extends_clause' ? heritage?.namedChild(0) : null);
      const ref = { kind: 'class', id: ir.rel + ':class:' + node.startIndex, base: base ? expression(base, at, self) : null, methods: new Map(), statics: new Map() };
      model.classes.push(ref);
      if (type === 'class') at = scope(at);
      bind(at, field(node, 'name')?.text, ref);
      const body = field(node, 'body');
      for (const method of body?.namedChildren || []) {
        const property = field(method, 'name') || field(method, 'property');
        const name = literal(property) ?? property?.text;
        if (method.type === 'method_definition' && name) {
          const target = method.children.some((child) => child.type === 'get' || child.type === 'set') ? UNKNOWN : expression(method, at, null);
          const table = method.children.some((child) => child.type === 'static') ? ref.statics : ref.methods;
          table.set(name, table.has(name) ? UNKNOWN : target);
        } else if (name && ['public_field_definition', 'field_definition'].includes(method.type)) {
          const table = method.children.some((child) => child.type === 'static') ? ref.statics : ref.methods;
          table.set(name, UNKNOWN);
        }
      }
      for (const child of body?.namedChildren || []) visit(child, at, owner, null, ref, depth + 1);
      return;
    }
    if (FUNCTIONS.has(type)) {
      const target = expression(node, at, self);
      if (type.endsWith('declaration')) bind(at, field(node, 'name')?.text, target);
      const inner = scope(at, true);
      if (type === 'function_expression' || type === 'generator_function') bind(inner, field(node, 'name')?.text, target);
      pattern(field(node, 'parameters') || field(node, 'parameter'), inner);
      const unit = units.get(node.startIndex);
      const methodSelf = type === 'method_definition' && cls
        ? (node.children.some((child) => child.type === 'static') ? { ...cls, polymorphic: true } : { kind: 'instance', cls, polymorphic: true })
        : type === 'arrow_function' ? self : null;
      const body = field(node, 'body');
      if (body) visit(body, inner, unit?.id || null, methodSelf, null, depth + 1);
      return;
    }
    if (BLOCKS.has(type)) {
      at = scope(at);
      if (type === 'catch_clause') pattern(field(node, 'parameter'), at);
      if (type === 'for_in_statement' && node.children.some((child) => ['let', 'const', 'var'].includes(child.type))) {
        let declaredAt = at;
        if (node.children.some((child) => child.type === 'var')) while (!model.scopes[declaredAt].function) declaredAt = model.scopes[declaredAt].parent;
        pattern(field(node, 'left'), declaredAt);
      }
    }
    if (type === 'variable_declarator') {
      let declarationScope = at;
      if (node.parent.type === 'variable_declaration') while (!model.scopes[declarationScope].function) declarationScope = model.scopes[declarationScope].parent;
      pattern(field(node, 'name'), declarationScope, expression(field(node, 'value'), at, self));
    }
    if (type === 'import_statement') {
      const spec = literal(field(node, 'source'));
      const clause = node.namedChildren.find((n) => n.type === 'import_clause');
      const typeOnly = node.children.some((n) => n.type === 'type');
      if (spec && clause) for (const child of clause.namedChildren) {
        if (child.type === 'identifier') bind(at, child.text, { kind: 'import', spec, name: 'default' });
        else if (child.type === 'namespace_import') bind(at, child.lastNamedChild.text, { kind: 'import', spec, name: '*' });
        else for (const item of child.namedChildren) {
          const name = field(item, 'name')?.text;
          if (name) bind(at, field(item, 'alias')?.text || name, typeOnly || item.children.some((n) => n.type === 'type') ? UNKNOWN : { kind: 'import', spec, name });
        }
      }
    }
    if (type === 'export_statement') {
      const spec = literal(field(node, 'source'));
      const declaration = field(node, 'declaration');
      const isDefault = node.children.some((n) => n.type === 'default');
      if (declaration) {
        const name = field(declaration, 'name')?.text;
        if (name) model.exports.set(isDefault ? 'default' : name, { kind: 'name', name, scope: at });
        else if (isDefault) model.exports.set('default', expression(declaration, at, self));
        for (const child of declaration.namedChildren) if (child.type === 'variable_declarator' && field(child, 'name')?.type === 'identifier') {
          const local = field(child, 'name').text;
          model.exports.set(local, { kind: 'name', name: local, scope: at });
        }
      } else if (isDefault) model.exports.set('default', expression(field(node, 'value'), at, self));
      const clause = node.namedChildren.find((n) => n.type === 'export_clause');
      const namespace = node.namedChildren.find((n) => n.type === 'namespace_export');
      if (spec && namespace) model.exports.set(namespace.lastNamedChild.text, { kind: 'import', spec, name: '*' });
      else if (spec && !clause && node.children.some((n) => n.type === '*')) model.exportStars.push(spec);
      for (const item of clause?.namedChildren || []) {
        const name = field(item, 'name')?.text;
        if (name) model.exports.set(field(item, 'alias')?.text || name, spec ? { kind: 'import', spec, name } : { kind: 'name', name, scope: at });
      }
    }
    if (type === 'assignment_expression' || type === 'augmented_assignment_expression' || type === 'update_expression' || (type === 'unary_expression' && node.children.some((n) => n.type === 'delete'))) {
      const left = field(node, 'left') || field(node, 'argument');
      if (left?.type === 'identifier') writes.push({ name: left.text, scope: at });
      if (left?.type === 'object_pattern' || left?.type === 'array_pattern') {
        const names = scope(null);
        pattern(left, names);
        for (const name of model.scopes[names].names.keys()) writes.push({ name, scope: at });
      }
      if (left?.type === 'member_expression' && !/^(module\.exports|(?:module\.)?exports\.[\w$]+)$/.test(left.text)) model.mutatedMembers.add(field(left, 'property')?.text || '*');
      if (left?.type === 'subscript_expression') model.mutatedMembers.add(literal(field(left, 'index')) ?? '*');
      if (owner === ir.rel + '#<módulo>') {
        const target = left?.text;
        const value = expression(field(node, 'right'), at, self);
        if (target === 'module.exports') {
          commonExports.push({ name: 'default', ref: value, scope: at, root: 'module' });
          if (value.kind === 'object') for (const [name, ref] of value.members) commonExports.push({ name, ref, scope: at, root: 'module' });
        } else {
          const match = /^(?:module\.)?exports\.([\w$]+)$/.exec(target || '');
          if (match) commonExports.push({ name: match[1], ref: value, scope: at, root: target.startsWith('module.') ? 'module' : 'exports' });
        }
      }
    }
    if (type === 'call_expression' || type === 'new_expression') {
      const callee = field(node, type === 'new_expression' ? 'constructor' : 'function');
      const binding = callee?.type === 'member_expression' && field(callee, 'property')?.text === 'bind';
      model.calls.push({ owner, line: node.startPosition.row + 1, ref: binding ? UNKNOWN : expression(callee, at, self), construct: type === 'new_expression' || callee?.type === 'super' });
    }
    for (const child of node.namedChildren) visit(child, at, owner, self, cls, depth + 1);
  };
  visit(root, 0, ir.rel + '#<módulo>', null, null);
  for (const write of writes) {
    const found = lookup(model, write.scope, write.name);
    if (found) found.names.set(write.name, UNKNOWN);
  }
  for (const item of commonExports) if (!lookup(model, item.scope, item.root)) model.exports.set(item.name, model.exports.has(item.name) ? UNKNOWN : item.ref);
  return model;
}

function lookup(model, at, name) {
  for (; at !== null; at = model.scopes[at].parent) if (model.scopes[at].names.has(name)) return model.scopes[at];
  return null;
}

function resolveCalls(file, byRel, importTargets, mutatedMembers = new Set()) {
  const dependencies = new Set([file.rel]);
  const modelFor = (rel) => { dependencies.add(rel); return byRel.get(rel)?.bindings; };
  const union = (targets) => {
    const values = targets.flatMap((target) => target?.kind === 'union' ? target.values : target ? [target] : []);
    return values.length === 1 ? values[0] : values.length ? { kind: 'union', values } : null;
  };
  const method = (cls, name, statics, seen) => {
    if (!cls || cls.kind !== 'class' || seen.has(cls.id)) return null;
    const next = new Set(seen).add(cls.id), table = statics ? cls.statics : cls.methods;
    if (table.has(name)) return resolve(table.get(name), cls.rel, next);
    if (cls.python) {
      const other = statics ? cls.methods : cls.statics;
      if (other.has(name)) return resolve(other.get(name), cls.rel, next);
    }
    return method(resolve(cls.base, cls.rel, next), name, statics, next);
  };
  const descendant = (cls, ancestor, seen = new Set()) => {
    if (!cls || cls.kind !== 'class' || seen.has(cls.id)) return false;
    if (cls.id === ancestor.id) return true;
    return descendant(resolve(cls.base, cls.rel), ancestor, new Set(seen).add(cls.id));
  };
  const dispatch = (cls, name, statics, polymorphic, seen) => {
    const targets = [method(cls, name, statics, seen)];
    if (polymorphic && cls?.kind === 'class') for (const [otherRel, other] of byRel) for (const candidate of other.bindings?.classes || []) {
      dependencies.add(otherRel);
      const child = { ...candidate, rel: otherRel };
      if (child.id !== cls.id && descendant(child, cls)) targets.push(method(child, name, statics, seen));
    }
    return union(targets);
  };
  const resolve = (ref, rel, seen = new Set()) => {
    if (!ref || seen.has(ref) || seen.size > 100) return null;
    const next = new Set(seen).add(ref);
    const model = modelFor(rel);
    if (!model) return null;
    if (ref.builtin && lookup(model, ref.scope, ref.builtin)) return null;
    if (ref.kind === 'name') return resolve(lookup(model, ref.scope, ref.name)?.names.get(ref.name), rel, next);
    if (ref.kind === 'bound') {
      if (mutatedMembers.has('bind')) return null;
      const target = resolve(ref.target, rel, next);
      return target?.kind === 'function' ? target : null;
    }
    if (ref.kind === 'python-instance') {
      const cls = resolve(ref.cls, rel, next);
      return cls?.kind === 'class' ? { kind: 'instance', cls, rel: cls.rel } : null;
    }
    if (ref.kind === 'super') {
      const self = resolve(ref.self, rel, next);
      const cls = self?.kind === 'instance' ? resolve(self.cls, self.rel, next) : self;
      const base = cls?.kind === 'class' ? resolve(cls.base, cls.rel, next) : null;
      return base && (self.kind === 'instance' ? { kind: 'instance', cls: base, rel: base.rel } : base);
    }
    if (ref.kind === 'import' || ref.kind === 'require') {
      if (ref.kind === 'require' && lookup(model, ref.scope, 'require')) return null;
      const targets = importTargets.get(rel)?.get(ref.spec);
      if (targets?.length !== 1) {
        const child = ref.python && importTargets.get(rel)?.get(ref.spec + (ref.spec.endsWith('.') ? '' : '.') + ref.name);
        return child?.length === 1 ? { kind: 'module', rel: child[0] } : null;
      }
      const dest = targets[0];
      if (ref.kind === 'require' || ref.name === '*') return { kind: 'module', rel: dest };
      return exported(dest, ref.name, next);
    }
    if (ref.kind === 'member') {
      const name = ref.name ?? resolve(ref.key, rel, next)?.value;
      if (typeof name !== 'string' || mutatedMembers.has('*') || mutatedMembers.has(name)) return null;
      const object = resolve(ref.object, rel, next);
      if (object?.kind === 'function' && (name === 'call' || name === 'apply')) return object;
      if (object?.kind === 'module') return exported(object.rel, name, next);
      if (object?.kind === 'class') return dispatch(object, name, true, object.polymorphic, next);
      if (object?.kind === 'instance') {
        let cls = resolve(object.cls, object.rel, next);
        if (cls?.kind === 'module') cls = exported(cls.rel, 'default', next);
        return dispatch(cls, name, false, object.polymorphic, next);
      }
      if (object?.kind === 'object') return resolve(object.members.get(name), object.rel, next);
      return null;
    }
    return ref.kind === 'unknown' ? null : { ...ref, rel };
  };
  const exported = (rel, name, seen) => {
    const exportKey = 'export:' + rel + ':' + name;
    if (seen.has(exportKey) || seen.size > 100) return null;
    seen = new Set(seen).add(exportKey);
    const model = modelFor(rel);
    if (!model) return null;
    if (model.exports.has(name)) return resolve(model.exports.get(name), rel, seen) || UNKNOWN;
    if (name !== 'default' && model.exportStars?.length) {
      const values = [];
      for (const spec of model.exportStars) {
        const destinations = importTargets.get(rel)?.get(spec);
        if (destinations?.length !== 1) return null;
        const target = exported(destinations[0], name, seen);
        if (target) values.push(target);
      }
      if (values.length) {
        const first = values[0];
        return first.id && values.every((value) => value.kind === first.kind && value.id === first.id) ? first : null;
      }
    }
    // CommonJS puede exportar un objeto a través de una variable.
    const def = name !== 'default' && resolve(model.exports.get('default'), rel, seen);
    return def?.kind === 'object' ? resolve(def.members.get(name), def.rel, seen) : null;
  };
  const edges = [], unresolved = [];
  for (const call of file.bindings.calls) {
    let target = resolve(call.ref, file.rel);
    if (target?.kind === 'module') target = exported(target.rel, 'default', new Set());
    if (call.construct && target?.kind === 'instance') target = resolve(target.cls, target.rel);
    if ((call.construct || call.python) && target?.kind === 'class') target = method(target, call.python ? '__init__' : 'constructor', false, new Set());
    const functions = (target?.kind === 'union' ? target.values : [target]).filter((value) => value?.kind === 'function');
    if (call.owner && functions.length) for (const id of new Set(functions.map((fn) => fn.id))) edges.push([call.owner, id]);
    else unresolved.push({ file: file.rel, line: call.line });
  }
  return { edges, unresolved, dependencies };
}

module.exports = { analyzeBindings, resolveCalls };
