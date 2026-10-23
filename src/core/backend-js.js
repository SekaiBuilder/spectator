'use strict';
// Mapa del backend para Next.js (rutas de API) y NestJS. Misma forma de resultado que Spring y Express
// (ver backend.js). Incluye los errores típicos del código hecho con prisa o por una IA en cada framework.
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.spectator', '.turbo', '.vercel', 'public', '.idea']);
const EXT = /\.(c|m)?(j|t)sx?$/;
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const readPkg = (root) => { try { return JSON.parse(readText(path.join(root, 'package.json')) || 'null'); } catch { return null; } };
const deps = (pkg) => ({ ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) });
const lineAt = (src, idx) => src.slice(0, idx).split('\n').length;
const joinPath = (a, b) => ('/' + [a, b].filter((x) => x && x !== '/').join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

function detectJs(root) {
  const d = deps(readPkg(root));
  if (d['@nestjs/core'] || d['@nestjs/common']) return 'nestjs';
  if (d.next) return 'nextjs';
  return null;
}

function jsFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 10) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1); }
      else if (EXT.test(e.name) && !/\.(test|spec|d)\.[cm]?[jt]sx?$/.test(e.name)) out.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  return out;
}

/** Desde la llave o paréntesis de apertura en `from` hasta su cierre, saltando cadenas y comentarios. */
function balanced(src, from) {
  const open = src[from], close = open === '{' ? '}' : open === '(' ? ')' : ']';
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { const q = c; i++; while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i === -1) break; i++; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return { text: src.slice(from + 1, i), end: i };
  }
  return { text: src.slice(from + 1), end: src.length };
}

/** Alias de rutas de tsconfig/jsconfig («@/lib/db» → src/lib/db). */
function aliases(root) {
  const out = [];
  for (const f of ['tsconfig.json', 'jsconfig.json']) {
    const s = readText(path.join(root, f));
    if (!s) continue;
    let j;
    try { j = JSON.parse(s.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')); } catch { continue; }
    const base = path.join(root, (j.compilerOptions && j.compilerOptions.baseUrl) || '.');
    for (const [k, v] of Object.entries((j.compilerOptions && j.compilerOptions.paths) || {})) out.push({ prefix: k.replace(/\*$/, ''), target: path.join(base, String(v[0] || '').replace(/\*$/, '')) });
  }
  if (!out.some((a) => a.prefix === '@/')) out.push({ prefix: '@/', target: fs.existsSync(path.join(root, 'src')) ? path.join(root, 'src') : root });
  return out;
}

function indexJs(root) {
  const files = new Map();
  const al = aliases(root);
  for (const abs of jsFiles(root)) {
    const src = readText(abs);
    if (src == null || src.length > 400000) continue;
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const f = { abs, rel, src, imports: new Map(), fns: new Map(), classes: new Map() };
    for (const m of src.matchAll(/import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+(\w+))?\s*from\s+['"]([^'"]+)['"]/g)) {
      if (m[1]) f.imports.set(m[1], { spec: m[4], name: 'default' });
      if (m[3]) f.imports.set(m[3], { spec: m[4], name: '*' });
      for (const part of (m[2] || '').split(',')) { const [n, a] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/); if (n) f.imports.set((a || n).trim(), { spec: m[4], name: n.trim() }); }
    }
    for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) f.imports.set(m[1], { spec: m[2], name: '*' });
    // Funciones: function x(, const x = (…) =>, export async function GET(, métodos de clase.
    const fnRe = /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(|(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>|^\s+(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\(/gm;
    for (const m of src.matchAll(fnRe)) {
      const name = m[1] || m[2] || m[3];
      if (!name || /^(if|for|while|switch|catch|return|function|constructor)$/.test(name)) continue;
      // Los parámetros pueden llevar llaves ({ params }) o decoradores (@Param('id')): el cuerpo empieza en la
      // primera llave después de cerrarlos. Un método de clase solo cuenta si tras los parámetros viene «: tipo {» o «{».
      const paren = src.indexOf('(', m.index);
      const sig = m[0].endsWith('(') ? balanced(src, paren) : null;
      let returns = null, brace;
      if (sig) {
        const after = /^\s*(?::\s*([^{;=]+?))?\s*(=>\s*)?\{/.exec(src.slice(sig.end + 1, sig.end + 300));
        if (m[3] && !after) continue;
        returns = after && after[1] ? after[1].trim() : null;
        brace = src.indexOf('{', sig.end);
      } else brace = src.indexOf('{', m.index + m[0].length - 1);
      if (brace === -1) continue;
      const blk = balanced(src, brace);
      const params = sig ? sig.text : (paren !== -1 && paren < brace ? balanced(src, paren).text : '');
      // Un método de clase empieza en «^\s+»; con CRLF, ^ también encaja tras \r y la coincidencia empezaría una línea antes.
      if (!f.fns.has(name)) f.fns.set(name, { name, line: lineAt(src, m.index + m[0].search(/\S/)), body: blk.text, params, returns, exported: /^\s*export/.test(m[0]), async: /async/.test(m[0]), method: !!m[3] });
    }
    for (const m of src.matchAll(/(?:export\s+)?class\s+(\w+)/g)) {
      const brace = src.indexOf('{', m.index);
      const deco = src.slice(Math.max(0, m.index - 400), m.index);
      f.classes.set(m[1], { name: m[1], line: lineAt(src, m.index), body: brace !== -1 ? balanced(src, brace).text : '', bodyStart: brace, decorators: (deco.match(/@\w+\([^)]*\)\s*$/gm) || []).join('\n') || ((/(@\w+\((?:[^()]|\([^)]*\))*\)\s*)+$/.exec(deco) || [''])[0]) });
    }
    files.set(rel, f);
  }
  const resolve = (from, spec) => {
    let base = null;
    if (spec.startsWith('.')) base = path.resolve(path.dirname(from.abs), spec);
    else { const a = al.find((x) => spec.startsWith(x.prefix)); if (a) base = path.join(a.target, spec.slice(a.prefix.length)); }
    if (!base) return null;
    for (const c of [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map((e) => base + e), ...['index.ts', 'index.js', 'index.tsx'].map((e) => path.join(base, e))]) {
      const rel = path.relative(root, c).split(path.sep).join('/');
      if (files.has(rel)) return files.get(rel);
    }
    return null;
  };
  return { files, resolve };
}

const DB_CALL = /\b(prisma|db|knex|pool|client|sql|supabase|mongoose|\w+Repository|\w+Model|this\.\w+Repository|this\.\w+Model|this\.prisma|this\.db)\s*((?:\.\s*\w+\s*)*?)\.\s*(findMany|findUnique|findFirst|findOne|findOneBy|findById|findAll|find|findBy|create|createMany|insert|insertOne|insertMany|update|updateOne|updateMany|upsert|delete|deleteOne|deleteMany|remove|destroy|save|query|execute|aggregate|count|from|select)\s*\(/g;
const verbOf = (name, H) => H.dbVerb(name === 'findUnique' || name === 'findOneBy' || name === 'findById' ? 'findById' : name === 'create' || name === 'insert' || name === 'insertOne' || name === 'createMany' || name === 'upsert' ? 'save' : name === 'update' || name === 'updateOne' || name === 'updateMany' ? 'save' : name === 'remove' || name === 'destroy' || name === 'deleteOne' || name === 'deleteMany' ? 'delete' : name === 'findMany' || name === 'findAll' || name === 'find' ? 'findAll' : name);
const DIR_ROLE = [[/(^|\/)(controllers?)\//, 'controller'], [/(^|\/)(services?|actions?)\//, 'service'], [/(^|\/)(repositor(y|ies)|db|database|prisma)\//, 'repository'], [/(^|\/)(dtos?|schemas?|validators?|types)\//, 'dto'], [/(^|\/)(models?|entities)\//, 'entity'], [/(^|\/)(clients?|integrations?)\//, 'client'], [/(^|\/)(middleware)\b/, 'middleware'], [/(^|\/)(lib|utils?|helpers?)\//, 'other']];
const roleOfFile = (rel) => (/\.controller\.[jt]s$/.test(rel) ? 'controller' : /\.service\.[jt]s$/.test(rel) ? 'service' : /\.repository\.[jt]s$/.test(rel) ? 'repository' : /\.entity\.[jt]s$/.test(rel) ? 'entity' : /\.dto\.[jt]s$/.test(rel) ? 'dto' : /\.module\.[jt]s$/.test(rel) ? 'config' : /(^|\/)route\.[jt]s$|(^|\/)pages\/api\//.test(rel) ? 'controller' : (DIR_ROLE.find(([re]) => re.test(rel)) || [, 'other'])[1]);

/** Sigue las llamadas de una función: a otros archivos importados, a la base de datos y a APIs externas. */
function follow(idx, f, body, depth, steps, seen, H, line, cls) {
  if (depth > 6) return;
  const events = [];
  for (const x of body.matchAll(/\b(?:fetch|axios(?:\.(get|post|put|patch|delete))?|this\.httpService\.(get|post|put|patch|delete)|ky(?:\.(get|post))?)\s*\(\s*[`'"](https?:\/\/[^`'"$]+)/g)) events.push({ at: x.index, external: { method: (x[1] || x[2] || x[3] || 'GET').toUpperCase(), url: x[4] } });
  for (const x of body.matchAll(DB_CALL)) events.push({ at: x.index, db: { cls: (x[1] + (x[2] || '')).replace(/\s+/g, '').replace(/^this\./, ''), method: x[3] } });
  for (const x of body.matchAll(/(?<![.\w])(this\.\w+|\w+)\s*\.\s*(\w+)\s*\(|(?<![.\w])(\w+)\s*\(/g)) {
    const owner = x[1], name = x[2] || x[3];
    if (!name || /^(require|if|for|while|switch|catch|return|await|async|function|json|status|send|log|error|warn|map|filter|reduce|push|then|catch|toString|parse|stringify|get|set|has)$/.test(name) && !owner) continue;
    let tf = null, fn = null;
    if (owner && owner.startsWith('this.') && cls) {
      // NestJS: this.servicio.metodo() — el tipo sale del constructor.
      const field = owner.slice(5);
      const typeName = (new RegExp(`\\b${field}\\s*:\\s*(\\w+)`).exec(cls.body) || [])[1];
      if (typeName) for (const g of idx.files.values()) if (g.classes.has(typeName)) { tf = g; fn = g.fns.get(name); break; }
    } else if (owner) {
      const imp = f.imports.get(owner);
      tf = imp && idx.resolve(f, imp.spec);
      fn = tf && tf.fns.get(name);
    } else {
      fn = f.fns.get(name); tf = fn ? f : null;
      if (!fn) { const imp = f.imports.get(name); tf = imp && idx.resolve(f, imp.spec); fn = tf && (tf.fns.get(imp.name === 'default' ? name : imp.name) || (imp.name === 'default' && [...tf.fns.values()].find((z) => z.exported))); }
    }
    if (fn && tf) events.push({ at: x.index, call: { f: tf, fn } });
  }
  events.sort((a, b) => a.at - b.at);
  for (const e of events) {
    if (e.external) steps.push({ depth: depth + 1, kind: 'external', method: e.external.method, url: e.external.url, ...H.roleInfo('client'), file: f.rel, line });
    else if (e.db) steps.push({ depth: depth + 1, kind: 'db', key: e.db.cls + '.' + e.db.method, cls: e.db.cls, method: e.db.method, verb: verbOf(e.db.method, H), ...H.roleInfo('repository'), file: f.rel, line });
    else {
      const key = e.call.f.rel + '#' + e.call.fn.name;
      if (seen.has(key)) continue;
      seen.add(key);
      const ownerCls = [...e.call.f.classes.values()].find((c) => c.body.includes(e.call.fn.body.slice(0, 60)));
      steps.push({ depth: depth + 1, kind: 'method', key, cls: ownerCls ? ownerCls.name : path.basename(e.call.f.rel).replace(/\.\w+$/, ''), method: e.call.fn.name, ...H.roleInfo(roleOfFile(e.call.f.rel)), file: e.call.f.rel, line: e.call.fn.line });
      follow(idx, e.call.f, e.call.fn.body, depth + 1, steps, seen, H, e.call.fn.line, ownerCls);
    }
  }
}

/** Texto de todas las funciones de un recorrido, para buscar códigos de respuesta y errores en toda la cadena. */
const chainText = (idx, steps, first) => [first, ...steps.filter((s) => s.kind === 'method' && s.depth > 0).map((s) => (idx.files.get(s.file) && idx.files.get(s.file).fns.get(s.method) || {}).body || '')].join('\n');

// ───────────────────────── Next.js
function nextRoutePath(rel) {
  // app/api/pedidos/[id]/route.ts → /api/pedidos/{id} · pages/api/pedidos/[id].ts → /api/pedidos/{id}
  let p = rel.replace(/^src\//, '');
  if (/^app\//.test(p)) p = p.replace(/^app/, '').replace(/\/route\.[cm]?[jt]sx?$/, '');
  else p = p.replace(/^pages/, '').replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
  p = p.split('/').filter((seg) => !/^\(.*\)$/.test(seg) && !/^@/.test(seg)).join('/');
  return (p || '/').replace(/\[\[?\.\.\.(\w+)\]?\]/g, '{$1*}').replace(/\[(\w+)\]/g, '{$1}');
}

function nextMap(root, F, H) {
  const idx = indexJs(root);
  const endpoints = [];
  const problems = [];
  for (const f of idx.files.values()) {
    const rel = f.rel.replace(/^src\//, '');
    const isApp = /^app\/.*\/?route\.[cm]?[jt]sx?$/.test(rel) || /^app\/route\./.test(rel);
    const isPages = /^pages\/api\//.test(rel);
    if (!isApp && !isPages) continue;
    const route = nextRoutePath(f.rel);
    const handlers = [];
    if (isApp) {
      for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) { const fn = f.fns.get(m); if (fn && fn.exported) handlers.push({ method: m, fn }); }
      // Error típico de IA: exportar «get» en minúsculas o un export default; Next.js no los llama.
      for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
        const fn = f.fns.get(m);
        if (fn && fn.exported) problems.push({ kind: 'lowercase', file: f.rel, line: fn.line, name: m, route });
      }
      if (/export\s+default\s+/.test(f.src)) problems.push({ kind: 'default', file: f.rel, line: lineAt(f.src, f.src.search(/export\s+default\s+/)), route });
    } else {
      const def = [...f.fns.values()].find((x) => x.exported) || f.fns.get('handler');
      const body = def ? def.body : f.src;
      const ms = [...new Set([...body.matchAll(/req\.method\s*===?\s*['"](\w+)['"]|case\s+['"](GET|POST|PUT|PATCH|DELETE)['"]/g)].map((x) => (x[1] || x[2]).toUpperCase()))];
      for (const m of ms.length ? ms : ['GET']) handlers.push({ method: m, fn: def || { name: 'handler', line: 1, body, params: '' } });
    }
    for (const h of handlers) {
      const steps = [{ depth: 0, kind: 'method', key: f.rel + '#' + h.method, cls: path.basename(path.dirname(f.rel)), method: h.method, ...H.roleInfo('controller'), file: f.rel, line: h.fn.line }];
      follow(idx, f, h.fn.body, 0, steps, new Set([f.rel + '#' + h.fn.name]), H, h.fn.line, null);
      const all = chainText(idx, steps, h.fn.body);
      const pathParams = [...route.matchAll(/\{(\w+)\*?\}/g)].map((x) => x[1]);
      const fields = [...new Set([
        ...[...all.matchAll(/(?:const|let)\s*\{([^}]+)\}\s*=\s*(?:[^;\n]*(?:req|request)\.json\(\)|(?:req\.body|body|data|json)\b)/g)].flatMap((x) => x[1].split(',').map((y) => y.trim().split(/[:=\s]/)[0]).filter((y) => /^\w+$/.test(y))),
        ...[...all.matchAll(/\b(?:body|req\.body|data)\.(\w+)/g)].map((x) => x[1]),
      ])];
      const readsBody = /(?:req|request)\.json\(\)|req\.body\b/.test(all);
      const inputs = [
        ...pathParams.map((p) => ({ name: p, type: 'string', where: 'path' })),
        ...(readsBody ? [{ name: 'body', type: fields.length ? '{ ' + fields.join(', ') + ' }' : 'JSON', where: 'body', fields, validated: /\.(parse|safeParse)\s*\(|\bvalidate\w*\(|yup\.|zod|Joi\./.test(all) }] : []),
        ...[...new Set([...all.matchAll(/searchParams\.get\(\s*['"](\w+)['"]|req\.query\.(\w+)/g)].map((x) => x[1] || x[2]))].filter((q) => !pathParams.includes(q)).map((q) => ({ name: q, type: 'string', where: 'query' })),
      ];
      const statuses = [...new Set([...all.matchAll(/status\s*:\s*(\d{3})|\.status\(\s*(\d{3})\s*\)/g)].map((x) => Number(x[1] || x[2])))];
      const status = statuses.find((s) => s < 400) || 200;
      const errors = statuses.filter((s) => s >= 400).map((s) => ({ exception: null, status: s, handled: true }));
      const out = { text: /\.json\s*\(|Response\.json|NextResponse\.json/.test(all) ? t`un objeto JSON` : /new\s+(Next)?Response\s*\(\s*null|status\s*:\s*204/.test(all) ? t`nada` : t`texto o datos`, cls: null, list: false };
      const empty = status === 204;
      endpoints.push({
        id: h.method + ' ' + route, method: h.method, path: route, handler: `${f.rel} ${h.method}`, file: f.rel, line: h.fn.line, inputs, output: { ...out, status, empty }, steps, errors,
        app: isApp, body: all,
        summary: H.endpointSummary({ method: h.method, inputs, out, outRole: null, status, empty, steps }),
      });
    }
  }
  // Variables de entorno privadas usadas en componentes de cliente: en el navegador valen undefined.
  for (const f of idx.files.values()) {
    if (!/^\s*['"]use client['"]/.test(f.src)) continue;
    for (const m of f.src.matchAll(/process\.env\.(?!NEXT_PUBLIC_)(\w+)/g)) problems.push({ kind: 'env', file: f.rel, line: lineAt(f.src, m.index), name: m[1] });
  }
  const findings = F ? nextFindings(endpoints, problems, F) : [];
  for (const e of endpoints) delete e.body;
  return { framework: 'nextjs', components: components(idx), endpoints, dtos: [], entities: prismaEntities(root), externals: externalsOf(endpoints), findings };
}

function nextFindings(endpoints, problems, F) {
  const out = duplicateRoutes(endpoints, F, t`Next.js no puede atender la misma ruta desde dos archivos: una de las dos definiciones se ignora o la compilación falla. Suele pasar al mezclar pages/api y app/api, algo frecuente en código generado por IA.`);
  for (const p of problems) {
    if (p.kind === 'lowercase') out.push(F('correctness', 'next-lowercase-handler', 'fail', p.file, p.line, p.route + ':' + p.name, {
      confidence: 96, title: t`${p.route} exporta «${p.name}» en minúsculas: Next.js nunca lo llama`,
      why: t`En app/…/route.ts los métodos tienen que llamarse GET, POST, PUT, PATCH o DELETE, en mayúsculas. Con «${p.name}» la ruta responde 405 (método no permitido).`,
      action: t`Renombrar la función a ${p.name.toUpperCase()}.`, tech: t`export function ${p.name} en un route handler`, evidence: [t`${p.file}:${p.line}`],
    }));
    if (p.kind === 'default') out.push(F('correctness', 'next-default-export-route', 'fail', p.file, p.line, p.route + ':default', {
      confidence: 92, title: t`${p.route} usa export default en un route handler`,
      why: t`Ese formato es el de pages/api. En app/…/route.ts Next.js ignora el export default y la ruta no responde. Es un error típico al mezclar los dos routers.`,
      action: t`Exportar funciones con nombre: export async function GET(request) { … }.`, tech: t`export default en route.ts`, evidence: [t`${p.file}:${p.line}`],
    }));
    if (p.kind === 'env') out.push(F('correctness', 'next-private-env-client', 'fail', p.file, p.line, p.name, {
      confidence: 93, title: t`process.env.${p.name} vale undefined en el navegador`,
      why: t`Este archivo es un componente de cliente («use client»). Next.js solo envía al navegador las variables que empiezan por NEXT_PUBLIC_; las demás valen undefined. Si es un secreto, no debe ir al navegador.`,
      action: t`Si no es secreto, renombrarla a NEXT_PUBLIC_${p.name}. Si lo es, usarla solo en el servidor (route handler o acción del servidor).`, tech: t`process.env.${p.name} en un componente de cliente`, evidence: [t`${p.file}:${p.line}`],
    }));
  }
  for (const e of endpoints) {
    // req.body no existe en app/…/route.ts: es de pages/api.
    if (e.app && /\breq\.body\b|\brequest\.body\s*\./.test(e.body)) out.push(F('correctness', 'next-req-body-app-router', 'fail', e.file, e.line, e.id + ':body', {
      confidence: 90, title: t`${e.id} lee req.body, que no existe en el App Router`,
      why: t`En app/…/route.ts el cuerpo se lee con await request.json(). req.body es de pages/api y aquí vale undefined. Es un error típico cuando una IA mezcla los dos estilos.`,
      action: t`Usar const datos = await request.json().`, tech: t`req.body en un route handler`, evidence: [t`${e.file}:${e.line}`],
    }));
    const body = e.inputs.find((i) => i.where === 'body');
    if (body && !body.validated && (e.method === 'POST' || e.method === 'PUT' || e.method === 'PATCH')) out.push(F('correctness', 'backend-unvalidated-body', 'risk', e.file, e.line, e.id, {
      confidence: 80, title: t`${e.id} usa los datos del cuerpo sin validarlos`,
      why: t`Nada comprueba que los campos existan y tengan el tipo correcto antes de usarlos. Datos incompletos o malintencionados llegan a tu base de datos.`,
      action: t`Validar con un esquema (por ejemplo zod: const datos = Esquema.parse(await request.json())).`, tech: t`Cuerpo sin validar`, evidence: [t`${e.file}:${e.line}`],
    }));
  }
  return out;
}

// ───────────────────────── NestJS
function nestMap(root, F, H) {
  const idx = indexJs(root);
  const endpoints = [], dtos = [], entities = [];
  const deco = (text, name) => { const m = new RegExp(`@${name}\\(\\s*(?:['"\`]([^'"\`]*)['"\`])?`).exec(text || ''); return m ? (m[1] || '') : null; };
  for (const f of idx.files.values()) {
    for (const c of f.classes.values()) {
      const base = deco(c.decorators, 'Controller');
      // DTO con class-validator
      if (/Dto$|DTO$/.test(c.name) || /(^|\/)dtos?\//.test(f.rel)) {
        const fields = [];
        for (const m of c.body.matchAll(/((?:@\w+\([^)]*\)\s*)*)(?:readonly\s+)?(\w+)(\?)?\s*[!:]\s*:?\s*([^;=\n]+)/g)) {
          if (!m[2] || /^(constructor|return)$/.test(m[2])) continue;
          const rules = [];
          const d = m[1] || '';
          if (/@IsNotEmpty|@IsDefined/.test(d) || (!m[3] && !/@IsOptional/.test(d))) rules.push(t`obligatorio`);
          if (/@IsEmail/.test(d)) rules.push(t`debe ser un email`);
          const min = /@Min\(\s*(-?[\d.]+)/.exec(d); if (min) rules.push(t`mínimo ${min[1]}`);
          const max = /@Max\(\s*(-?[\d.]+)/.exec(d); if (max) rules.push(t`máximo ${max[1]}`);
          if (/@IsPositive/.test(d)) rules.push(t`mayor que 0`);
          const len = /@(?:Length|MinLength)\(\s*(\d+)/.exec(d); if (len) rules.push(t`al menos ${len[1]} caracteres`);
          if (/@Matches/.test(d)) rules.push(t`debe cumplir un formato`);
          fields.push({ name: m[2], type: m[4].trim(), rules, validators: /@Is\w+|@Min|@Max|@Length|@Matches/.test(d) });
        }
        dtos.push({ name: c.name, file: f.rel, line: c.line, fields, kind: 'dto', input: [], output: [], createdIn: [], unused: false, hasValidators: fields.some((x) => x.validators) });
      }
      if (/@Entity\(/.test(c.decorators)) entities.push({ name: c.name, file: f.rel, line: c.line, table: deco(c.decorators, 'Entity') || null, fields: [...c.body.matchAll(/@(PrimaryGeneratedColumn|PrimaryColumn|Column|ManyToOne|OneToMany|OneToOne|ManyToMany)\(([^)]*)\)\s*(\w+)\s*[!?]?:\s*([^;\n]+)/g)].map((m) => ({ name: m[3], type: m[4].trim(), id: /Primary/.test(m[1]), relation: /To/.test(m[1]) ? { kind: m[1], target: (/=>\s*(\w+)/.exec(m[2]) || [])[1] || m[4].replace(/\[\]/, '').trim() } : null })) });
      if (base == null) continue;
      for (const m of c.body.matchAll(/@(Get|Post|Put|Patch|Delete|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)((?:\s*@\w+\([^)]*\))*)\s*(?:public\s+)?(?:async\s+)?(\w+)\s*\(/g)) {
        const fn = f.fns.get(m[4]);
        const method = m[1].toUpperCase();
        const route = joinPath(base, m[2] || '').replace(/:(\w+)/g, '{$1}');
        const params = fn ? fn.params : '';
        const inputs = [];
        for (const p of params.split(/,(?![^<]*>)/)) {
          const pm = /@(Param|Body|Query|Headers)\(\s*(?:['"](\w+)['"])?[^)]*\)\s*(\w+)\s*:\s*([\w<>[\]]+)/.exec(p);
          if (!pm) continue;
          const where = { Param: 'path', Body: 'body', Query: 'query', Headers: 'header' }[pm[1]];
          inputs.push({ name: pm[2] || pm[3], type: pm[4], where, dto: /Dto$|DTO$/.test(pm[4]) ? pm[4] : null, validated: true });
        }
        const steps = [{ depth: 0, kind: 'method', key: f.rel + '#' + m[4], cls: c.name, method: m[4], ...H.roleInfo('controller'), file: f.rel, line: fn ? fn.line : c.line }];
        if (fn) follow(idx, f, fn.body, 0, steps, new Set([f.rel + '#' + m[4]]), H, fn.line, c);
        const all = chainText(idx, steps, fn ? fn.body : '');
        const extra = m[3] || '';
        const code = Number((/@HttpCode\(\s*(?:HttpStatus\.\w+|(\d{3}))/.exec(extra) || [])[1]) || (/@HttpCode\(\s*HttpStatus\.NO_CONTENT/.test(extra) ? 204 : /@HttpCode\(\s*HttpStatus\.CREATED/.test(extra) ? 201 : null);
        const status = code || (method === 'POST' ? 201 : 200);
        const ret = fn && fn.returns ? fn.returns.replace(/^Promise<(.+)>$/, '$1').replace(/^Observable<(.+)>$/, '$1').trim() : null;
        const errors = [...new Set([...all.matchAll(/throw\s+new\s+(\w+Exception)/g)].map((x) => x[1]))].map((ex) => ({ exception: ex, status: { NotFoundException: 404, BadRequestException: 400, UnauthorizedException: 401, ForbiddenException: 403, ConflictException: 409, InternalServerErrorException: 500 }[ex] || 500, handled: true, by: 'NestJS' }));
        const outName = ret && ret.replace(/\[\]$/, '');
        const out = { text: ret === 'void' || status === 204 ? t`nada` : !ret ? t`un objeto JSON` : /\[\]$/.test(ret) ? t`una lista de ${outName}` : ret, cls: ret && ret !== 'void' ? outName : null, list: /\[\]$/.test(ret || '') };
        const outRole = out.cls && entities.some((e) => e.name === out.cls) ? 'entity' : null;
        endpoints.push({ id: method + ' ' + route, method, path: route, handler: c.name + '.' + m[4], file: f.rel, line: fn ? fn.line : c.line, inputs, output: { ...out, role: outRole, status, empty: status === 204 }, steps, errors, summary: H.endpointSummary({ method, inputs, out, outRole, status, empty: status === 204, steps }) });
      }
    }
  }
  for (const d of dtos) {
    d.input = endpoints.filter((e) => e.inputs.some((i) => i.dto === d.name)).map((e) => e.id);
    d.output = endpoints.filter((e) => e.output.cls === d.name).map((e) => e.id);
    d.kind = d.input.length ? 'request' : d.output.length ? 'response' : 'dto';
    d.unused = ![...idx.files.values()].some((f) => f.rel !== d.file && new RegExp('\\b' + d.name + '\\b').test(f.src));
  }
  const findings = [];
  if (F) {
    findings.push(...duplicateRoutes(endpoints, F, t`NestJS registra la primera definición que encaja; la segunda nunca se ejecuta. Suele pasar cuando una IA añade un método sin ver que ya existía.`));
    // Sin ValidationPipe, los decoradores de class-validator no hacen nada.
    const main = [...idx.files.values()].find((f) => /NestFactory\.create/.test(f.src));
    const pipes = [...idx.files.values()].some((f) => /ValidationPipe/.test(f.src));
    if (dtos.some((d) => d.hasValidators) && !pipes) findings.push(F('correctness', 'nest-missing-validation-pipe', 'fail', main ? main.rel : dtos.find((d) => d.hasValidators).file, 1, 'validation-pipe', {
      confidence: 92, title: t`Los DTO tienen reglas (@IsEmail, @Min…) pero nadie las aplica`,
      why: t`NestJS solo comprueba los decoradores de class-validator si está activo ValidationPipe. Sin él se acepta cualquier dato. Es un olvido muy frecuente en proyectos generados con IA.`,
      action: t`Añadir app.useGlobalPipes(new ValidationPipe({ whitelist: true })) en main.ts.`, tech: t`Sin ValidationPipe`, evidence: dtos.filter((d) => d.hasValidators).map((d) => d.file),
    }));
    for (const e of endpoints) if (e.output.role === 'entity') findings.push(F('architecture', 'backend-entity-response', 'risk', e.file, e.line, e.id, {
      confidence: 85, title: t`${e.id} devuelve la entidad ${e.output.cls} en vez de un DTO`,
      why: t`El cliente recibe todas las columnas de la tabla, también las que no debería ver, y cualquier cambio en la base de datos cambia tu API.`,
      action: t`Devolver un DTO de salida con solo los campos necesarios.`, tech: t`Retorno ${e.output.cls}`, evidence: [t`${e.file}:${e.line}`],
    }));
    for (const d of dtos) if (d.unused) findings.push(F('maintainability', 'backend-unused-dto', 'risk', d.file, d.line, d.name, {
      confidence: 80, title: t`El DTO ${d.name} no se usa en ningún sitio`,
      why: t`Ningún controlador, servicio ni otra clase lo menciona. Suele quedar cuando una IA genera piezas «por si acaso». Confunde a quien lee el código.`,
      action: t`Borrarlo si no hace falta, o usarlo donde se pensó usar.`, tech: t`${d.name} sin referencias`, evidence: [d.file],
    }));
  }
  return { framework: 'nestjs', components: components(idx), endpoints, dtos, entities, externals: externalsOf(endpoints), findings };
}

// ───────────────────────── Comunes
function duplicateRoutes(endpoints, F, why) {
  const out = [];
  const byRoute = new Map();
  for (const e of endpoints) (byRoute.get(e.id) || byRoute.set(e.id, []).get(e.id)).push(e);
  for (const [id, list] of byRoute) for (const dup of list.slice(1)) out.push(F('correctness', 'backend-duplicate-route', 'fail', dup.file, dup.line, id + '|' + dup.handler, {
    confidence: 95, title: t`${id} está definido dos veces`, why, action: t`Borrar una de las dos o cambiar su ruta.`, tech: t`Ruta duplicada`,
    evidence: list.map((e) => `${e.file}:${e.line}`), related: [{ file: list[0].file, line: list[0].line }],
  }));
  return out;
}
function components(idx) {
  const list = [...idx.files.values()].filter((f) => !/\.(tsx|jsx)$/.test(f.rel) || /route\.|pages\/api\//.test(f.rel)).map((f) => ({
    id: f.rel, name: path.basename(f.rel), file: f.rel, line: 1, role: roleOfFile(f.rel),
    deps: [...new Set([...f.imports.values()].map((i) => idx.resolve(f, i.spec)).filter(Boolean).map((x) => x.rel))].filter((r) => r !== f.rel), methods: [...f.fns.keys()],
  }));
  const usedBy = new Map();
  for (const c of list) for (const d of c.deps) (usedBy.get(d) || usedBy.set(d, []).get(d)).push(c.id);
  for (const c of list) c.usedBy = usedBy.get(c.id) || [];
  return list;
}
function externalsOf(endpoints) {
  const out = new Map();
  for (const e of endpoints) for (const s of e.steps) if (s.kind === 'external') out.set(s.method + s.url, { method: s.method, url: s.url, from: e.id, file: s.file, line: s.line });
  return [...out.values()];
}
/** Modelos de prisma/schema.prisma como entidades (tablas). */
function prismaEntities(root) {
  const s = readText(path.join(root, 'prisma', 'schema.prisma'));
  if (!s) return [];
  const models = [...s.matchAll(/^model\s+(\w+)\s*\{([^}]*)\}/gm)];
  const names = new Set(models.map((m) => m[1]));
  return models.map((m) => ({
    name: m[1], file: 'prisma/schema.prisma', line: lineAt(s, m.index), table: (/@@map\("(\w+)"\)/.exec(m[2]) || [])[1] || null,
    fields: m[2].split('\n').map((l) => l.trim()).filter((l) => /^\w+\s+\w/.test(l) && !l.startsWith('@@')).map((l) => {
      const [name, type] = l.split(/\s+/);
      const target = type.replace(/[[\]?]/g, '');
      return { name, type, id: /@id\b/.test(l), relation: names.has(target) ? { kind: /\[\]/.test(type) ? 'OneToMany' : 'ManyToOne', target } : null };
    }),
  }));
}

/** Errores de componentes: se aplica a cualquier mapa JS que tenga roles. */
function jsMap(root, F, H, framework) {
  const map = framework === 'nestjs' ? nestMap(root, F, H) : nextMap(root, F, H);
  for (const c of map.components) Object.assign(c, H.roleInfo(c.role));
  return map;
}

module.exports = { detectJs, jsMap, nextRoutePath, indexJs };
