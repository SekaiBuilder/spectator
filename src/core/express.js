'use strict';
// Node/Express: índice ligero de rutas (con los prefijos de app.use) y reglas estáticas que no fallan al escribir
// el código pero sí al usarlo. El mismo índice sirve al modo en vivo (noderun.js) para llevar cada error a su línea.
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');

const SKIP_DIRS = new Set(['node_modules', '.git', '.spectator', 'dist', 'build', 'coverage', 'out', '.next', 'public', 'test', 'tests', '__tests__']);
const EXT = /\.(c|m)?(j|t)s$/;
const METHODS = 'get|post|put|patch|delete';

function readPkg(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return null; }
}
const deps = (pkg) => ({ ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) });

function isExpressProject(root) {
  const pkg = readPkg(root);
  return !!(pkg && deps(pkg).express);
}

function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name)); }
      else if (EXT.test(e.name) && !/\.(test|spec|d)\.[cm]?[jt]s$/.test(e.name)) out.push(path.join(dir, e.name));
    }
  };
  walk(root);
  return out;
}

const lineAt = (src, idx) => src.slice(0, idx).split('\n').length;
const joinPath = (a, b) => ('/' + [a, b].filter((x) => x && x !== '/').join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

/** Desde el paréntesis de apertura en `from` hasta su cierre, saltando cadenas y comentarios. */
function balanced(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { const q = c; i++; while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i === -1) break; i++; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return { text: src.slice(from + 1, i), end: i };
  }
  return { text: src.slice(from + 1), end: src.length };
}

/** Separa los argumentos de una llamada por comas de primer nivel. */
function splitArgs(text) {
  const out = [];
  let depth = 0, cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { const q = c; let j = i + 1; while (j < text.length && text[j] !== q) j += text[j] === '\\' ? 2 : 1; cur += text.slice(i, j + 1); i = j; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Resuelve un import relativo a un archivo del proyecto. */
function resolveLocal(fromAbs, spec) {
  if (!spec || !spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromAbs), spec);
  for (const c of [base, ...['.js', '.ts', '.mjs', '.cjs'].map((e) => base + e), ...['index.js', 'index.ts'].map((e) => path.join(base, e))]) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* siguiente */ }
  }
  // ESM con TypeScript: import './x.js' apunta a x.ts
  const ts = base.replace(/\.js$/, '.ts');
  return fs.existsSync(ts) ? ts : null;
}

/** Campos que un handler lee del cuerpo: req.body.x y const { a, b } = req.body. */
function bodyFields(body) {
  const names = new Set();
  for (const m of body.matchAll(/\breq\.body\.(\w+)/g)) names.add(m[1]);
  for (const m of body.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*req\.body\b/g)) {
    for (const part of m[1].split(',')) { const n = part.trim().split(/[:=\s]/)[0]; if (/^\w+$/.test(n)) names.add(n); }
  }
  return [...names];
}

function indexExpress(root) {
  const pkg = readPkg(root);
  const files = new Map(); // abs -> { rel, src, routers:Set, routes:[], mounts:[], imports:Map }
  for (const abs of sourceFiles(root)) {
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (src.length > 400000) continue;
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const f = { abs, rel, src, apps: new Set(), routers: new Set(), routes: [], mounts: [], imports: new Map(), named: new Map(), exportsRouter: null };
    for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:express|require\(\s*['"]express['"]\s*\))\s*\(\s*\)/g)) f.apps.add(m[1]);
    for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:express\.Router|Router|require\(\s*['"]express['"]\s*\)\.Router)\s*\(/g)) f.routers.add(m[1]);
    // Función que crea y devuelve un router: export function deckRoutes() { const r = express.Router(); … return r; }
    f.factories = new Map();
    for (const m of src.matchAll(/(?:function\s+(\w+)\s*\(|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*=>)/g)) {
      const fname = m[1] || m[2];
      const rest = src.slice(m.index, m.index + 4000);
      const r = /(?:const|let|var)\s+(\w+)\s*=\s*(?:express\.Router|Router)\s*\(/.exec(rest);
      if (r && f.routers.has(r[1]) && !f.factories.has(fname)) {
        const next = rest.slice(1).search(/\n(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/);
        if (next === -1 || r.index < next) f.factories.set(fname, r[1]);
      }
    }
    for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) f.imports.set(m[1], m[2]);
    for (const m of src.matchAll(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g)) f.imports.set(m[1], m[2]);
    // Importaciones con nombre: import { deckRoutes } from './routes/decks.js' y const { a, b } = require('./x').
    for (const m of src.matchAll(/(?:import\s*\{([^}]*)\}\s*from|(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\()\s*['"]([^'"]+)['"]/g)) {
      for (const part of (m[1] || m[2]).split(',')) {
        const names = part.trim().split(/\s+as\s+|\s*:\s*/);
        const local = (names[1] || names[0]).trim();
        if (/^\w+$/.test(local)) { f.imports.set(local, m[3]); f.named.set(local, names[0].trim()); }
      }
    }
    const exp = /module\.exports\s*=\s*(\w+)|export\s+default\s+(\w+)/.exec(src);
    if (exp) f.exportsRouter = exp[1] || exp[2];
    const owners = new Set([...f.apps, ...f.routers]);
    for (const m of src.matchAll(new RegExp(`\\b(\\w+)\\.(${METHODS})\\s*\\(\\s*(['"\`])([^'"\`]*)\\3`, 'g'))) {
      if (!owners.has(m[1]) && !/^(app|router|api|routes?)$/i.test(m[1])) continue;
      const open = m.index + m[0].indexOf('(');
      const call = balanced(src, open);
      const handler = call.text.replace(/^\s*(['"`])[^'"`]*\1\s*,?/, '');
      f.routes.push({ owner: m[1], method: m[2].toUpperCase(), path: m[4], line: lineAt(src, m.index), endLine: lineAt(src, call.end), body: handler, async: /\basync\b/.test(handler.slice(0, 200)) });
    }
    // Encadenado: const api = Router().use(a).use(b)  ·  export default Router().use('/api', api)
    const uses = [...src.matchAll(/\b(\w+)\.use\(/g)].map((m) => ({ owner: m[1], open: m.index + m[0].length - 1, at: m.index }));
    const chainFrom = (owner, from) => {
      let i = from;
      for (;;) {
        const next = /^\s*\.use\s*\(/.exec(src.slice(i));
        if (!next) break;
        const open = i + next[0].length - 1;
        uses.push({ owner, open, at: i });
        i = balanced(src, open).end + 1;
      }
    };
    for (const m of src.matchAll(/(?:(?:const|let|var)\s+(\w+)\s*=|export\s+default)\s*(?:express\.)?Router\s*\(/g)) {
      const owner = m[1] || '__default__';
      if (!m[1]) { f.routers.add(owner); f.exportsRouter = owner; }
      chainFrom(owner, balanced(src, m.index + m[0].length - 1).end + 1);
    }
    for (const m of uses) {
      const call = balanced(src, m.open);
      const args = splitArgs(call.text);
      const lit = args.length && /^(['"`])([^'"`]*)\1$/.exec(args[0]);
      const prefix = lit ? lit[2] : '';
      for (const a of lit ? args.slice(1) : args) {
        const req = /^require\(\s*['"]([^'"]+)['"]\s*\)$/.exec(a);
        // Un router que devuelve una función: app.use('/api', deckRoutes(opciones)).
        const factory = /^(\w+)\s*\(/.exec(a);
        const name = factory ? factory[1] : a;
        const spec = req ? req[1] : f.imports.get(name);
        if (spec && spec.startsWith('.')) f.mounts.push({ owner: m.owner, prefix, spec, factory: factory ? (f.named.get(name) || name) : null, line: lineAt(src, m.at) });
        else if (f.routers.has(a)) f.mounts.push({ owner: m.owner, prefix, local: a, line: lineAt(src, m.at) });
        else if (factory && f.factories && f.factories.has(name)) f.mounts.push({ owner: m.owner, prefix, local: f.factories.get(name), line: lineAt(src, m.at) });
      }
    }
    files.set(abs, f);
  }
  // Prefijos: se parte de los archivos con express() y se siguen los app.use('/prefijo', router).
  const endpoints = [];
  const seen = new Set();
  const visit = (f, owner, prefix, depth) => {
    const key = f.abs + '#' + owner + '#' + prefix;
    if (seen.has(key) || depth > 8) return;
    seen.add(key);
    for (const r of f.routes) {
      if (r.owner !== owner) continue;
      endpoints.push({ method: r.method, path: joinPath(prefix, r.path), file: f.rel, line: r.line, endLine: r.endLine, handler: `${r.method} ${joinPath(prefix, r.path)}`, body: r.body, async: r.async, fields: bodyFields(r.body) });
    }
    for (const m of f.mounts) {
      if (m.owner !== owner) continue;
      if (m.local) { visit(f, m.local, joinPath(prefix, m.prefix), depth + 1); continue; }
      const target = files.get(resolveLocal(f.abs, m.spec));
      if (!target) continue;
      const routerVar = m.factory && target.factories.has(m.factory) ? target.factories.get(m.factory)
        : target.exportsRouter && (target.routers.has(target.exportsRouter) || target.apps.has(target.exportsRouter)) ? target.exportsRouter : [...target.routers][0];
      if (routerVar) visit(target, routerVar, joinPath(prefix, m.prefix), depth + 1);
    }
  };
  const roots = [...files.values()].filter((f) => f.apps.size);
  for (const f of roots) for (const app of f.apps) visit(f, app, '', 0);
  // Archivos de rutas que nadie monta (o montados de una forma que no se reconoce): se incluyen sin prefijo.
  if (!roots.length) for (const f of files.values()) for (const r of f.routers) visit(f, r, '', 0);
  return { root, pkg, files: [...files.values()], endpoints, appFiles: roots.map((f) => f.rel) };
}

const major = (range) => Number((/(\d+)/.exec(String(range || '')) || [])[1] || 0);
const VALIDATION = /\b(joi|zod|yup|express-validator|celebrate|ajv|class-validator|validate|validationResult|safeParse|\.parse\()\b/;

/** Reglas estáticas de Express. */
function expressFindings(root, F, idx = indexExpress(root)) {
  const out = [];
  const pkg = idx.pkg || {};
  const all = idx.files.map((f) => f.src).join('\n');
  const usesBody = idx.endpoints.filter((e) => /\breq\.body\b/.test(e.body));
  // req.body sin express.json(): llega undefined y el handler falla o guarda vacío.
  if (usesBody.length && !/express\.json\s*\(|bodyParser\.json\s*\(|express\.urlencoded\s*\(|bodyParser\.urlencoded\s*\(/.test(all)) {
    const e = usesBody[0];
    out.push(F('correctness', 'express-no-json-parser', 'fail', idx.appFiles[0] || e.file, 1, 'json-parser', {
      confidence: 95, title: t`Se usa req.body pero no hay express.json()`,
      why: t`Sin ese middleware Express no lee el JSON que envía el cliente: req.body llega undefined y ${e.handler} falla o guarda datos vacíos.`,
      action: t`Añadir app.use(express.json()) antes de montar las rutas.`,
      tech: t`req.body en ${usesBody.length} rutas; ningún express.json() ni bodyParser.json()`, evidence: usesBody.slice(0, 5).map((x) => `${x.handler} (${x.file}:${x.line})`),
      related: [{ file: e.file, line: e.line }],
    }));
  }
  // Express 4: un error en un handler async no llega al gestor de errores.
  const asyncSafe = major(deps(pkg).express) >= 5 || /express-async-errors|express-async-handler|asyncHandler|catchAsync|wrapAsync/.test(all);
  for (const e of idx.endpoints) {
    if (!asyncSafe && e.async && !/\btry\s*\{/.test(e.body) && !/\.catch\s*\(/.test(e.body) && /\bawait\b/.test(e.body)) {
      out.push(F('correctness', 'express-async-no-catch', 'risk', e.file, e.line, e.handler, {
        confidence: 85, title: t`${e.handler} es async y no captura errores`,
        why: t`En Express 4, si algo falla dentro de un handler async, el error no llega al gestor de errores: la petición se queda colgada o el proceso entero se cae (unhandled rejection).`,
        action: t`Envolver el cuerpo en try/catch y llamar a next(err), usar express-async-errors o actualizar a Express 5.`,
        tech: t`handler async sin try/catch (express ${deps(pkg).express})`, evidence: [`${e.file}:${e.line}`],
      }));
    }
    if (/:\w+/.test(e.path) && e.method !== 'POST' && /\.(find|findById|findOne|findByPk|findUnique|findIndex)\s*\(|\[\s*\w*[iI]d\w*\s*\]/.test(e.body) && !/\b404\b|NotFound|notFound|sendStatus\(\s*404/.test(e.body)) {
      out.push(F('correctness', 'express-missing-404', 'risk', e.file, e.line, e.handler, {
        confidence: 80, title: t`${e.handler} no responde 404 si el registro no existe`,
        why: t`El handler busca un registro por su id pero no comprueba si lo encontró. Con un id inexistente responde 200 vacío o falla con 500.`,
        action: t`Comprobar el resultado y responder res.status(404) cuando no exista.`,
        tech: t`búsqueda sin rama 404 en ${e.handler}`, evidence: [`${e.file}:${e.line}`],
      }));
    }
    if ((e.method === 'POST' || e.method === 'PUT' || e.method === 'PATCH') && /\breq\.body\b/.test(e.body) && !VALIDATION.test(e.body) && !/\b400\b|\bthrow\b|if\s*\(\s*!/.test(e.body)) {
      const fileSrc = (idx.files.find((f) => f.rel === e.file) || {}).src || '';
      if (VALIDATION.test(fileSrc.slice(0, 2000)) && /\b(validate|celebrate|body\()/.test(fileSrc.split('\n')[e.line - 1] || '')) continue;
      out.push(F('correctness', 'express-no-validation', 'risk', e.file, e.line, e.handler, {
        confidence: 75, title: t`${e.handler} guarda req.body sin validarlo`,
        why: t`No hay ninguna comprobación de los datos que llegan: se aceptan campos vacíos, de otro tipo o inventados.`,
        action: t`Validar el cuerpo (zod, joi, express-validator o un if) y responder 400 si no es válido.`,
        tech: t`req.body sin validación en ${e.handler}`, evidence: [`${e.file}:${e.line}`],
      }));
    }
  }
  return out;
}

module.exports = { isExpressProject, indexExpress, expressFindings, readPkg, deps, bodyFields };
