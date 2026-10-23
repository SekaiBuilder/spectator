'use strict';
// Mapa del backend para Python: FastAPI y Flask. Misma forma de resultado que Spring y Express (ver backend.js):
// endpoints con lo que reciben y devuelven, recorrido hasta la base de datos u otra API, modelos Pydantic (los DTO
// de Python), modelos de base de datos (SQLAlchemy/SQLModel) y errores típicos del código hecho con prisa o por una IA.
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');

const SKIP = new Set(['venv', '.venv', 'env', '__pycache__', 'node_modules', '.git', '.tox', '.mypy_cache', '.pytest_cache', 'build', 'dist', 'site-packages', 'migrations', 'alembic', '.spectator', '.idea']);

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

/** «fastapi», «flask» o «django» si el proyecto los declara (requirements, pyproject, Pipfile) o los importa. */
function detectPython(root) {
  const decl = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'requirements/base.txt'].map((f) => readText(path.join(root, f)) || '').join('\n').toLowerCase();
  if (/\bfastapi\b/.test(decl)) return 'fastapi';
  if (/\bflask\b/.test(decl)) return 'flask';
  if (/\bdjango\b/.test(decl) || readText(path.join(root, 'manage.py')) != null) return 'django';
  for (const f of pyFiles(root).slice(0, 300)) {
    const s = readText(f) || '';
    if (/^\s*(from fastapi import|import fastapi)/m.test(s)) return 'fastapi';
    if (/^\s*(from flask import|import flask)/m.test(s)) return 'flask';
    if (/^\s*(from django[\s.]|import django)/m.test(s)) return 'django';
  }
  return null;
}

function pyFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1); }
      else if (e.name.endsWith('.py') && !/^test_|_test\.py$/.test(e.name)) out.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  return out;
}

const lineAt = (src, idx) => src.slice(0, idx).split('\n').length;
const joinPath = (a, b) => ('/' + [a, b].filter((x) => x && x !== '/').join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
const strArg = (args, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*['"]([^'"]*)['"]`).exec(args || ''); return m ? m[1] : null; };
const firstStr = (args) => { const m = /^\s*[rf]?['"]([^'"]*)['"]/.exec(args || ''); return m ? m[1] : null; };

/** Paréntesis equilibrados desde `from` (en el '('), saltando cadenas. */
function balanced(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") { const q = c; const triple = src.slice(i, i + 3) === q.repeat(3); if (triple) { const end = src.indexOf(q.repeat(3), i + 3); i = end === -1 ? src.length : end + 2; continue; } i++; while (i < src.length && src[i] !== q && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return { text: src.slice(from + 1, i), end: i };
  }
  return { text: src.slice(from + 1), end: src.length };
}

/** Separa por comas de primer nivel. */
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const c of s) {
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Cuerpo de una función por sangría, a partir de la línea de su `def`. */
function blockAfter(lines, defLine) {
  const head = lines[defLine - 1] || '';
  const indent = head.length - head.trimStart().length;
  const out = [];
  let i = defLine; // empieza en la línea siguiente al def (las firmas largas se toleran: se cortan en la primera línea vacía de sangría menor)
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { out.push(l); continue; }
    const ind = l.length - l.trimStart().length;
    if (ind <= indent && !/^\s*[)\]]/.test(l)) break;
    out.push(l);
  }
  return { body: out.join('\n'), endLine: defLine + out.length };
}

/** Índice: módulos, imports, funciones, clases Pydantic y de base de datos, routers y endpoints. */
function indexPython(root) {
  const mods = new Map();
  for (const abs of pyFiles(root)) {
    const src = readText(abs);
    if (src == null || src.length > 400000) continue;
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const modName = rel.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.');
    mods.set(modName, { abs, rel, mod: modName, src, lines: src.split('\n'), imports: new Map(), fns: new Map(), classes: new Map(), apps: new Map(), routes: [], includes: [], defs: [] });
  }
  const resolveMod = (from, spec) => {
    // from .services import x  ·  from app.crud import y  ·  import app.crud as crud
    if (spec.startsWith('.')) {
      const dots = /^\.+/.exec(spec)[0].length;
      const baseParts = from.mod.split('.');
      const isPkg = /\/__init__\.py$/.test(from.rel);
      const up = baseParts.slice(0, baseParts.length - (isPkg ? dots - 1 : dots));
      return [...up, ...spec.slice(dots).split('.').filter(Boolean)].join('.');
    }
    if (mods.has(spec)) return spec;
    // Paquete en src/ o en la raíz con otro prefijo
    for (const k of mods.keys()) if (k.endsWith('.' + spec) || k === spec) return k;
    return spec;
  };
  for (const m of mods.values()) {
    const s = m.src;
    for (const x of s.matchAll(/^\s*from\s+([.\w]+)\s+import\s+\(?([^)\n]+)\)?/gm)) {
      const target = resolveMod(m, x[1]);
      for (const part of x[2].split(',')) {
        const [name, alias] = part.trim().split(/\s+as\s+/);
        if (!name || name === '*') continue;
        // «from app import crud»: crud puede ser un módulo o un nombre del paquete.
        const asMod = mods.has(target + '.' + name) ? target + '.' + name : null;
        m.imports.set((alias || name).trim(), asMod ? { mod: asMod } : { mod: target, name: name.trim() });
      }
    }
    for (const x of s.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm)) m.imports.set(x[2] || x[1].split('.').pop(), { mod: resolveMod(m, x[1]) });
    for (const x of s.matchAll(/^([ \t]*)(?:async\s+)?def\s+(\w+)\s*\(/gm)) {
      const line = lineAt(s, x.index);
      const sig = balanced(s, x.index + x[0].length - 1);
      const after = s.slice(sig.end + 1, s.indexOf(':', sig.end) + 1);
      const ret = (/->\s*([^:]+):/.exec(after) || [])[1];
      const sigEndLine = lineAt(s, sig.end);
      const blk = blockAfter(m.lines, sigEndLine);
      const fn = { name: x[2], line, params: splitTop(sig.text), returns: ret ? ret.trim() : null, body: blk.body, endLine: blk.endLine, async: /async\s+def/.test(x[0]), indent: x[1].length };
      m.defs.push(fn);
      if (!m.fns.has(fn.name) || fn.indent === 0) m.fns.set(fn.name, fn);
    }
    for (const x of s.matchAll(/^class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/gm)) {
      const line = lineAt(s, x.index);
      const blk = blockAfter(m.lines, line);
      const bases = (x[2] || '').split(',').map((b) => b.trim());
      const fields = [];
      for (const f of blk.body.matchAll(/^\s{2,}(\w+)\s*:\s*([^=\n#]+?)(?:\s*=\s*([^\n#]+))?\s*(?:#.*)?$/gm)) {
        if (/^(model_config|Config|class)$/.test(f[1])) continue;
        fields.push({ name: f[1], type: f[2].trim(), default: f[3] ? f[3].trim() : null });
      }
      // SQLAlchemy clásico: nombre = Column(Tipo, ...)
      for (const f of blk.body.matchAll(/^\s{2,}(\w+)\s*=\s*(Column|mapped_column|relationship|db\.Column|db\.relationship)\s*\(([^\n]*)\)/gm)) {
        if (fields.some((x) => x.name === f[1])) continue;
        fields.push({ name: f[1], type: f[2].includes('relationship') ? 'relationship(' + f[3] + ')' : (f[3].split(',')[0] || '').trim(), default: null, column: f[3] });
      }
      const isTable = /__tablename__/.test(blk.body) || /table\s*=\s*True/.test(x[2] || '') || bases.some((b) => /^(Base|db\.Model|Model|DeclarativeBase)$/.test(b));
      const isSchema = !isTable && bases.some((b) => /BaseModel|SQLModel|Schema/.test(b));
      m.classes.set(x[1], { name: x[1], line, endLine: blk.endLine, bases, fields, body: blk.body, table: isTable, schema: isSchema, tablename: (/__tablename__\s*=\s*['"](\w+)['"]/.exec(blk.body) || [])[1] || null });
    }
    // Aplicación y routers
    for (const x of s.matchAll(/^(\w+)\s*=\s*(FastAPI|APIRouter|Flask|Blueprint)\s*\(/gm)) {
      const args = balanced(s, x.index + x[0].length - 1).text;
      m.apps.set(x[1], { kind: x[2], prefix: x[2] === 'APIRouter' ? strArg(args, 'prefix') || '' : x[2] === 'Blueprint' ? strArg(args, 'url_prefix') || '' : '' });
    }
    for (const x of s.matchAll(/^(\w+)\.(include_router|register_blueprint)\s*\(/gm)) {
      const args = balanced(s, x.index + x[0].length - 1).text;
      const target = splitTop(args)[0] || '';
      m.includes.push({ owner: x[1], target, prefix: strArg(args, 'prefix') || strArg(args, 'url_prefix') || '' });
    }
    // Endpoints: @app.get("/x", ...), @router.post(...), @app.route("/x", methods=["POST"])
    for (const x of s.matchAll(/^[ \t]*@(\w+)\.(get|post|put|patch|delete|route|api_route)\s*\(/gm)) {
      const args = balanced(s, x.index + x[0].length - 1);
      const after = s.slice(args.end + 1);
      const def = /^\s*(?:\n\s*@[^\n]*)*\n\s*(?:async\s+)?def\s+(\w+)/.exec(after);
      if (!def) continue;
      let methods = [x[2].toUpperCase()];
      if (x[2] === 'route' || x[2] === 'api_route') {
        const ms = /methods\s*=\s*\[([^\]]*)\]/.exec(args.text);
        methods = ms ? [...ms[1].matchAll(/['"](\w+)['"]/g)].map((y) => y[1].toUpperCase()) : ['GET'];
      }
      for (const method of methods) {
        m.routes.push({ owner: x[1], method, path: firstStr(args.text) || '/', args: args.text, handler: def[1], line: lineAt(s, x.index) });
      }
    }
  }
  // Prefijos: se resuelve qué router está incluido en qué app y con qué prefijo.
  const prefixOf = new Map(); // "mod#var" → [prefijos completos]
  const keyOf = (mod, v) => mod + '#' + v;
  for (const m of mods.values()) for (const [v, a] of m.apps) if (a.kind === 'FastAPI' || a.kind === 'Flask') prefixOf.set(keyOf(m.mod, v), ['']);
  for (let pass = 0; pass < 6; pass++) {
    for (const m of mods.values()) {
      for (const inc of m.includes) {
        const owners = prefixOf.get(keyOf(m.mod, inc.owner));
        if (!owners) continue;
        // users.router · router (importado) · api_router
        const [a, b] = inc.target.split('.');
        let tmod = null, tvar = null;
        if (b) { const imp = m.imports.get(a); tmod = imp && (imp.mod && !imp.name ? imp.mod : imp && imp.mod + '.' + imp.name); tvar = b; if (tmod && !mods.has(tmod) && imp) tmod = imp.mod; }
        else { const imp = m.imports.get(a); if (imp) { tmod = imp.name ? imp.mod : imp.mod; tvar = imp.name || a; } else { tmod = m.mod; tvar = a; } }
        if (!tmod || !mods.has(tmod)) continue;
        const target = mods.get(tmod).apps.get(tvar);
        if (!target) continue;
        const k = keyOf(tmod, tvar);
        const list = prefixOf.get(k) || [];
        for (const o of owners) { const full = joinPath(joinPath(o, inc.prefix), target.prefix); if (!list.includes(full)) list.push(full); }
        prefixOf.set(k, list);
      }
    }
  }
  return { mods, prefixOf, resolveMod };
}

const PY_DB = /\b(db|session|Session|self\.db|self\.session|cursor|conn|connection|collection|\w+_collection)\s*\.\s*(query|add|add_all|commit|delete|get|execute|exec|scalars|scalar|merge|refresh|flush|find|find_one|insert_one|insert_many|update_one|delete_one|count_documents)\s*\(/g;
const PY_ORM = /\b([A-Z]\w+)\s*\.\s*(objects\.\w+|query\.\w+|select|get_or_404|filter_by|find_one)\s*\(/g;
const PY_DB_VERB = { query: 'consulta', add: 'guarda', add_all: 'guarda', commit: 'confirma los cambios', delete: 'borra', get: 'busca por id', execute: 'consulta', exec: 'consulta', scalars: 'consulta', scalar: 'consulta', merge: 'guarda', refresh: 'vuelve a leer', flush: 'escribe', find: 'busca', find_one: 'busca', insert_one: 'guarda', insert_many: 'guarda', update_one: 'actualiza', delete_one: 'borra', count_documents: 'cuenta' };
const pyVerb = (name) => ({ consulta: t`consulta`, guarda: t`guarda`, 'confirma los cambios': t`confirma los cambios`, borra: t`borra`, 'busca por id': t`busca por id`, 'vuelve a leer': t`vuelve a leer`, escribe: t`escribe`, busca: t`busca`, actualiza: t`actualiza`, cuenta: t`cuenta` })[PY_DB_VERB[name] || 'consulta'] || t`consulta`;

// Recorrido: llamadas a funciones de otros módulos (crud.create_item) o del mismo (helper()), en el orden del código.
// Con django, también objeto.save() / objeto.delete() y serializer.save() (escriben en la base de datos).
function stepper(mods, H, opts = {}) {
  const steps0 = (m, fn, depth, steps, seen) => {
    if (depth > 6 || !fn) return;
    const body = fn.body;
    const events = [];
    for (const x of body.matchAll(/\b(requests|httpx|client|session|aiohttp|http)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*f?['"](https?:\/\/[^'"]+)['"]/g)) events.push({ at: x.index, external: { method: x[2].toUpperCase(), url: x[3] } });
    for (const x of body.matchAll(PY_DB)) events.push({ at: x.index, db: { cls: x[1], method: x[2], verb: pyVerb(x[2]) } });
    for (const x of body.matchAll(PY_ORM)) events.push({ at: x.index, db: { cls: x[1], method: x[2], verb: ormVerb(x[2]) } });
    if (opts.django) for (const x of body.matchAll(/\b([a-z_]\w*)\s*\.\s*(save|delete)\s*\(\s*\)/g)) if (!/^(self|request|response|super)$/.test(x[1])) events.push({ at: x.index, db: { cls: x[1], method: x[2], verb: x[2] === 'save' ? t`guarda` : t`borra` } });
    for (const x of body.matchAll(/(?<![.\w])(\w+)\s*\.\s*(\w+)\s*\(|(?<![.\w])(\w+)\s*\(/g)) {
      const owner = x[1], name = x[2] || x[3];
      let tm = null, tf = null;
      if (owner) { const imp = m.imports.get(owner); const target = imp && mods.get(imp.name ? imp.mod + '.' + imp.name : imp.mod) || (imp && mods.get(imp.mod)); if (target) { tm = target; tf = target.fns.get(name); } }
      else if (m.fns.has(name) && name !== fn.name) { tm = m; tf = m.fns.get(name); }
      else { const imp = m.imports.get(name); const target = imp && imp.name && mods.get(imp.mod); if (target) { tm = target; tf = target.fns.get(imp.name); } }
      if (tm && tf) events.push({ at: x.index, call: { m: tm, fn: tf } });
    }
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.external) steps.push({ depth: depth + 1, kind: 'external', method: e.external.method, url: e.external.url, ...H.roleInfo('client'), file: m.rel, line: fn.line });
      else if (e.db) steps.push({ depth: depth + 1, kind: 'db', key: e.db.cls + '.' + e.db.method, cls: e.db.cls, method: e.db.method, verb: e.db.verb, ...H.roleInfo('repository'), file: m.rel, line: fn.line });
      else {
        const key = e.call.m.rel + '#' + e.call.fn.name;
        if (seen.has(key)) continue;
        seen.add(key);
        steps.push({ depth: depth + 1, kind: 'method', key, cls: e.call.m.mod.split('.').pop(), method: e.call.fn.name, ...H.roleInfo(roleOfFile(e.call.m.rel)), file: e.call.m.rel, line: e.call.fn.line, returns: e.call.fn.returns || '' });
        steps0(e.call.m, e.call.fn, depth + 1, steps, seen);
      }
    }
  };

  return steps0;
}

/** Verbo de una llamada del ORM (objects.create, query.filter, select…). */
const ormVerb = (name) => {
  const last = String(name).split('.').pop();
  if (/^(create|bulk_create|get_or_create|update_or_create)$/.test(last)) return t`guarda`;
  if (/^(get|get_or_404|first|last)$/.test(last)) return t`busca`;
  if (/^(delete)$/.test(last)) return t`borra`;
  if (/^(update|bulk_update)$/.test(last)) return t`actualiza`;
  if (/^(count|exists)$/.test(last)) return t`cuenta`;
  return t`consulta`;
};

const DIR_ROLE = [[/(^|\/)(routers?|routes|api|endpoints|views?)\//, 'controller'], [/(^|\/)(services?|crud|use_?cases?|logic)\//, 'service'], [/(^|\/)(repositor(y|ies)|daos?|db|database)\//, 'repository'], [/(^|\/)(schemas?|dtos?|serializers?)\//, 'dto'], [/(^|\/)(models?|entities)\//, 'model'], [/(^|\/)(clients?|integrations?|external)\//, 'client'], [/(^|\/)(core|config|settings)\//, 'config'], [/(^|\/)(middlewares?)\//, 'middleware']];
const FILE_ROLE = [[/(^|\/)(main|app|wsgi|asgi|__main__)\.py$/, 'app'], [/(^|\/)(routers?|routes|views?|api)\.py$/, 'controller'], [/(^|\/)(services?|crud)\.py$/, 'service'], [/(^|\/)(schemas?|dtos?|serializers?)\.py$/, 'dto'], [/(^|\/)urls\.py$/, 'routes'], [/(^|\/)(models?)\.py$/, 'model'], [/(^|\/)(database|db|deps)\.py$/, 'repository'], [/(^|\/)(config|settings)\.py$/, 'config']];
const roleOfFile = (rel) => (FILE_ROLE.find(([re]) => re.test(rel)) || DIR_ROLE.find(([re]) => re.test(rel)) || [, 'other'])[1];

const RULES_FIELD = (expr) => {
  const out = [];
  const add = (re, fn) => { const m = re.exec(expr || ''); if (m) out.push(fn(m)); };
  add(/\bgt\s*=\s*(-?[\d.]+)/, (m) => (m[1] === '0' ? t`mayor que 0` : t`mayor que ${m[1]}`));
  add(/\bge\s*=\s*(-?[\d.]+)/, (m) => t`mínimo ${m[1]}`);
  add(/\blt\s*=\s*(-?[\d.]+)/, (m) => t`menor que ${m[1]}`);
  add(/\ble\s*=\s*(-?[\d.]+)/, (m) => t`máximo ${m[1]}`);
  add(/\bmin_length\s*=\s*(\d+)/, (m) => (m[1] === '1' ? t`no vacío` : t`al menos ${m[1]} caracteres`));
  add(/\bmax_length\s*=\s*(\d+)/, (m) => t`como mucho ${m[1]} caracteres`);
  add(/\b(pattern|regex)\s*=/, () => t`debe cumplir un formato`);
  return out;
};
function pyFieldRules(f) {
  const rules = [];
  // Field(gt=0) sigue siendo obligatorio; Field(10, …), Field(default=…) o «= valor» lo hacen opcional.
  const d = f.default;
  const fieldDefault = d && /^Field\(/.test(d) ? /^Field\(\s*(?!\.\.\.)[^=,)\s][^=,)]*[,)]/.test(d) || /\bdefault(_factory)?\s*=/.test(d) : null;
  const optional = /Optional\[|\|\s*None|None\s*\|/.test(f.type) || (d != null && (fieldDefault == null ? !/^\.\.\.$/.test(d) : fieldDefault));
  if (!optional) rules.push(t`obligatorio`);
  if (/EmailStr/.test(f.type)) rules.push(t`debe ser un email`);
  if (/HttpUrl|AnyUrl/.test(f.type)) rules.push(t`debe ser una URL`);
  if (/PositiveInt|PositiveFloat/.test(f.type)) rules.push(t`mayor que 0`);
  if (/conint|confloat|constr|Field|Annotated/.test((f.type || '') + ' ' + (f.default || ''))) rules.push(...RULES_FIELD((f.type || '') + ' ' + (f.default || '')));
  return rules;
}

/**
 * @param H utilidades comunes de backend.js: { roleInfo, endpointSummary }
 */
function pythonMap(root, F, H) {
  const framework = detectPython(root);
  if (!framework) return null;
  if (framework === 'django') return require('./backend-django').djangoMap(root, F, H);
  const { mods, prefixOf } = indexPython(root);
  const schemas = new Map(), tables = new Map();
  for (const m of mods.values()) for (const c of m.classes.values()) { if (c.schema) schemas.set(c.name, { ...c, file: m.rel }); if (c.table) tables.set(c.name, { ...c, file: m.rel }); }
  const typeName = (tp) => { const names = (String(tp || '').match(/\b[A-Z]\w*/g) || []).filter((n) => !/^(List|Optional|Union|Dict|Annotated|Sequence|Iterable|Set|Tuple|Response|JSONResponse|Any|Literal|Query|Path|Body|Depends|Field)$/.test(n)); return names.pop() || null; };
  const isList = (tp) => /^\s*(list|List|Sequence|Iterable)\[/.test(tp || '');
  // Alias de dependencias (SessionDep = Annotated[Session, Depends(get_db)]): los inyecta FastAPI, no llegan en la petición.
  const depAliases = new Set();
  for (const m of mods.values()) for (const a of m.src.matchAll(/^(\w+)\s*(?::\s*\w+\s*)?=\s*Annotated\[[^\n]*\bDepends\s*\(/gm)) depAliases.add(a[1]);

  const steps0 = stepper(mods, H);

  const endpoints = [];
  for (const m of mods.values()) {
    for (const r of m.routes) {
      const app = m.apps.get(r.owner);
      const prefixes = prefixOf.get(m.mod + '#' + r.owner) || [app ? app.prefix : ''];
      const fn = m.fns.get(r.handler);
      for (const prefix of prefixes) {
        const full = joinPath(prefix, r.path).replace(/<(?:\w+:)?(\w+)>/g, '{$1}');
        const pathParams = [...full.matchAll(/\{(\w+)(?::[^}]*)?\}/g)].map((x) => x[1]);
        const inputs = [];
        for (const p of fn ? fn.params : []) {
          const pm = /^\*{0,2}(\w+)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/s.exec(p);
          if (!pm || /^(self|cls|request|req|response|background_tasks)$/.test(pm[1]) || /Depends\s*\(/.test(pm[3] || '') || /\b(Request|Response|BackgroundTasks|Session|AsyncSession)\b/.test(pm[2] || '') || /Depends\s*\(/.test(pm[2] || '') || depAliases.has((pm[2] || '').trim())) continue;
          const tp = (pm[2] || '').trim();
          const tn = typeName(tp);
          const where = pathParams.includes(pm[1]) || /Path\s*\(/.test(pm[3] || '') ? 'path' : (tn && schemas.has(tn)) || /Body\s*\(/.test(pm[3] || '') || /^dict\b|^Dict\b/.test(tp) ? 'body' : /Header\s*\(/.test(pm[3] || '') ? 'header' : 'query';
          inputs.push({ name: pm[1], type: tp || 'str', where, dto: tn && schemas.has(tn) ? tn : null, entity: tn && tables.has(tn) ? tn : null, validated: !!(tn && schemas.has(tn)), raw: /^(dict|Dict)\b/.test(tp) });
        }
        // Flask: request.json / request.get_json() / request.form
        if (framework === 'flask' && fn) {
          const fields = [...new Set([...fn.body.matchAll(/request\.(?:json|get_json\(\)|form)\s*(?:\[\s*['"](\w+)['"]\s*\]|\.get\(\s*['"](\w+)['"])/g)].map((x) => x[1] || x[2]))];
          if (fields.length || /request\.(json|get_json|form)/.test(fn.body)) inputs.push({ name: 'body', type: '{ ' + fields.join(', ') + ' }', where: 'body', fields, validated: false, raw: true });
          for (const q of new Set([...fn.body.matchAll(/request\.args\.get\(\s*['"](\w+)['"]/g)].map((x) => x[1]))) inputs.push({ name: q, type: 'str', where: 'query' });
          for (const pp of pathParams) if (!inputs.some((i) => i.name === pp)) inputs.push({ name: pp, type: 'str', where: 'path' });
        }
        const respModel = (/response_model\s*=\s*([^,)\n]+)/.exec(r.args) || [])[1];
        const outType = respModel || (fn && fn.returns) || null;
        const outName = typeName(outType);
        const explicit = Number((/status_code\s*=\s*(?:status\.HTTP_)?(\d{3})/.exec(r.args) || [])[1]) || null;
        const flaskStatus = fn ? Number((/return\s+[^\n]*,\s*(\d{3})\s*$/m.exec(fn.body) || [])[1]) || null : null;
        const status = explicit || flaskStatus || (r.method === 'POST' && framework === 'fastapi' ? 200 : 200);
        const empty = status === 204 || (fn && !/\breturn\b\s*\S/.test(fn.body));
        const steps = [{ depth: 0, kind: 'method', key: m.rel + '#' + r.handler, cls: m.mod.split('.').pop(), method: r.handler, ...H.roleInfo('controller'), file: m.rel, line: fn ? fn.line : r.line }];
        if (fn) steps0(m, fn, 0, steps, new Set([m.rel + '#' + r.handler]));
        const all = [fn ? fn.body : '', ...steps.filter((s) => s.kind === 'method' && s.depth > 0).map((s) => { const mm = mods.get([...mods.values()].find((x) => x.rel === s.file)?.mod); return mm && mm.fns.get(s.method) ? mm.fns.get(s.method).body : ''; })].join('\n');
        const errors = [...new Set([...all.matchAll(/raise\s+HTTPException\s*\(\s*(?:status_code\s*=\s*)?(?:status\.HTTP_)?(\d{3})/g)].map((x) => Number(x[1])))].map((s) => ({ exception: 'HTTPException', status: s, handled: true, by: null }));
        if (framework === 'flask') for (const s of new Set([...all.matchAll(/\babort\s*\(\s*(\d{3})/g)].map((x) => Number(x[1])))) errors.push({ exception: 'abort', status: s, handled: true, by: null });
        const out = { text: !outType ? (empty ? t`nada` : t`un objeto JSON`) : isList(outType) ? t`una lista de ${outName}` : outName || outType, cls: outName, list: isList(outType) };
        const outRole = outName && tables.has(outName) ? 'entity' : outName && schemas.has(outName) ? 'dto' : null;
        endpoints.push({
          id: r.method + ' ' + full, method: r.method, path: full, handler: m.mod + '.' + r.handler, file: m.rel, line: r.line,
          inputs, output: { ...out, role: outRole, status, empty }, steps, errors, async: !!(fn && fn.async), body: all, responseModel: !!respModel,
          summary: H.endpointSummary({ method: r.method, inputs, out, outRole, status, empty, steps }),
        });
      }
    }
  }
  // Los __init__.py vacíos no son piezas: solo marcan carpetas como paquetes.
  const components = [...mods.values()].filter((m) => m.src.trim() || m.fns.size || m.classes.size).map((m) => ({
    id: m.rel, name: m.rel.split('/').pop(), file: m.rel, line: 1, ...H.roleInfo(m.routes.length ? 'controller' : [...m.apps.values()].some((a) => a.kind === 'FastAPI' || a.kind === 'Flask') ? 'app' : roleOfFile(m.rel)),
    deps: [...new Set([...m.imports.values()].map((i) => mods.get(i.name && mods.has(i.mod + '.' + i.name) ? i.mod + '.' + i.name : i.mod)).filter(Boolean).map((x) => x.rel))].filter((r) => r !== m.rel),
    methods: [...m.fns.keys()],
  }));
  const usedBy = new Map();
  for (const c of components) for (const d of c.deps) (usedBy.get(d) || usedBy.set(d, []).get(d)).push(c.id);
  for (const c of components) c.usedBy = usedBy.get(c.id) || [];
  const allSrc = [...mods.values()].map((m) => m.src).join('\n');
  const dtos = [...schemas.values()].map((c) => {
    const input = endpoints.filter((e) => e.inputs.some((i) => i.dto === c.name)).map((e) => e.id);
    const output = endpoints.filter((e) => e.output.cls === c.name).map((e) => e.id);
    const uses = (allSrc.match(new RegExp('\\b' + c.name + '\\b', 'g')) || []).length;
    return { name: c.name, file: c.file, line: c.line, kind: input.length ? 'request' : output.length ? 'response' : 'dto', fields: c.fields.map((f) => ({ name: f.name, type: f.type, rules: pyFieldRules(f) })), input, output, createdIn: [], unused: uses <= 1 };
  });
  // Una ForeignKey apunta a una tabla («clientes.id»): se traduce al nombre de su clase (Cliente).
  const classOfTable = new Map([...tables.values()].filter((c) => c.tablename).map((c) => [c.tablename, c.name]));
  const entities = [...tables.values()].map((c) => ({
    name: c.name, file: c.file, line: c.line, table: c.tablename,
    fields: c.fields.map((f) => {
      const rel = /relationship\(\s*['"]?(\w+)/.exec(f.type) || /Mapped\[\s*(?:list|List)\[\s*['"]?(\w+)/.exec(f.type);
      const fk = /ForeignKey\(\s*['"](\w+)\./.exec(f.column || f.type || '');
      return { name: f.name, type: f.type, id: /primary_key\s*=\s*True/.test((f.column || '') + (f.default || '')), relation: rel ? { kind: /list|List/.test(f.type) || /uselist/.test(f.type) ? 'OneToMany' : 'ManyToOne', target: rel[1] } : fk ? { kind: 'ManyToOne', target: classOfTable.get(fk[1]) || fk[1] } : null };
    }),
  }));
  const externals = endpoints.flatMap((e) => e.steps.filter((s) => s.kind === 'external').map((s) => ({ method: s.method, url: s.url, from: e.id, file: s.file, line: s.line })));
  const findings = F ? pythonFindings({ endpoints, dtos, tables, framework, mods }, F) : [];
  for (const e of endpoints) { delete e.body; }
  return { framework, components, endpoints, dtos, entities, externals: [...new Map(externals.map((x) => [x.method + x.url, x])).values()], findings };
}

/** Errores típicos del código Python hecho con prisa o por una IA. */
function pythonFindings({ endpoints, dtos, tables, framework, mods }, F) {
  const out = [];
  const byRoute = new Map();
  for (const e of endpoints) (byRoute.get(e.id) || byRoute.set(e.id, []).get(e.id)).push(e);
  for (const [id, list] of byRoute) for (const dup of list.slice(1)) {
    out.push(F('correctness', 'backend-duplicate-route', 'fail', dup.file, dup.line, id + '|' + dup.handler, {
      confidence: 95, title: t`${id} está definido dos veces`,
      why: t`${framework === 'fastapi' ? 'FastAPI' : 'Flask'} usa solo la primera definición que encaja (${list[0].handler}); ${dup.handler} nunca se ejecuta, aunque parezca que sí. Suele pasar cuando una IA añade una ruta sin ver que ya existía.`,
      action: t`Borrar una de las dos o cambiar su ruta.`, tech: t`Ruta duplicada`, evidence: list.map((e) => `${e.file}:${e.line} ${e.handler}`), related: [{ file: list[0].file, line: list[0].line }],
    }));
  }
  for (const e of endpoints) {
    // Bloquear el servidor: requests (síncrono) dentro de un endpoint async.
    if (e.async && /\brequests\.(get|post|put|patch|delete)\s*\(/.test(e.body)) {
      out.push(F('performance', 'python-blocking-in-async', 'risk', e.file, e.line, e.id, {
        confidence: 90, title: t`${e.id} usa requests dentro de una función async`,
        why: t`requests espera la respuesta bloqueando el servidor entero: mientras tanto ninguna otra petición se atiende. Es un error frecuente cuando una IA mezcla código síncrono y asíncrono.`,
        action: t`Usar httpx.AsyncClient con await, o quitar async de la función.`, tech: t`requests en async def ${e.handler}`, evidence: [t`${e.file}:${e.line}`],
      }));
    }
    // Cuerpo sin validar: dict en vez de un modelo Pydantic.
    const raw = e.inputs.find((i) => i.where === 'body' && i.raw);
    if (raw && framework === 'fastapi') {
      out.push(F('correctness', 'python-unvalidated-body', 'risk', e.file, e.line, e.id, {
        confidence: 88, title: t`${e.id} acepta cualquier JSON: el cuerpo es un dict`,
        why: t`Con un dict, FastAPI no comprueba qué campos llegan ni de qué tipo son. Datos incompletos o incorrectos llegan hasta tu base de datos.`,
        action: t`Definir un modelo Pydantic (class ${raw.name.charAt(0).toUpperCase() + raw.name.slice(1)}In(BaseModel)) con sus campos y usarlo como tipo del parámetro.`,
        tech: t`Parámetro ${raw.name}: ${raw.type}`, evidence: [t`${e.file}:${e.line}`],
      }));
    }
    // Devolver un modelo de base de datos sin response_model: expone todas las columnas.
    if (e.output.role === 'entity' && !e.responseModel && framework === 'fastapi') {
      out.push(F('architecture', 'python-entity-response', 'risk', e.file, e.line, e.id, {
        confidence: 85, title: t`${e.id} devuelve el modelo de base de datos ${e.output.cls}`,
        why: t`Sin un modelo de respuesta, el cliente recibe todas las columnas de la tabla, también las que no debería ver (contraseñas, datos internos).`,
        action: t`Crear un modelo Pydantic de salida y declararlo con response_model.`, tech: t`Retorno ${e.output.cls} sin response_model`, evidence: [t`${e.file}:${e.line}`],
      }));
    }
  }
  for (const d of dtos) {
    if (!d.unused) continue;
    out.push(F('maintainability', 'backend-unused-dto', 'risk', d.file, d.line, d.name, {
      confidence: 80, title: t`El modelo ${d.name} no se usa en ningún sitio`,
      why: t`Ningún endpoint ni función lo menciona. Suele quedar cuando una IA genera piezas «por si acaso». Confunde a quien lee el código.`,
      action: t`Borrarlo si no hace falta, o usarlo donde se pensó usar.`, tech: t`${d.name} sin referencias`, evidence: [d.file],
    }));
  }
  void tables; void mods;
  return out;
}

module.exports = { pythonMap, detectPython, indexPython, stepper, balanced, splitTop, blockAfter, roleOfFile, readText };
