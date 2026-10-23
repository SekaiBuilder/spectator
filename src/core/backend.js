'use strict';
// Mapa del backend en palabras sencillas: qué endpoints hay, qué recibe y qué devuelve cada uno (sus DTO), qué
// componente llama a cuál hasta la base de datos o una API externa, y qué hace cada pieza. Pensado para estudiar el
// código (también el que escribe una IA) y para encontrar sus errores típicos.
//
// Todo sale de leer el código, sin ejecutarlo. Lo que no se puede seguir leyendo (llamadas dinámicas, inyección
// por nombre, reflexión) no se inventa: el paso queda sin destino.
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');
const spring = require('./spring');
const express = require('./express');
const { pythonMap } = require('./backend-python');
const { detectJs, jsMap } = require('./backend-js');
const { guessTarget } = require('./apiwatch');

// ───────────────────────── Vocabulario
const ROLE = {
  controller: () => [t`Controlador`, t`Recibe las peticiones HTTP (las llamadas a tu API), lee los datos que llegan y devuelve la respuesta. No debería contener la lógica: se la pide a un servicio.`],
  service: () => [t`Servicio`, t`Contiene la lógica de negocio: las reglas de lo que hace tu aplicación. Lo usan los controladores y él usa los repositorios.`],
  repository: () => [t`Repositorio`, t`Habla con la base de datos: buscar, guardar, borrar. En Spring Data muchos métodos (findById, save…) ya vienen hechos.`],
  entity: () => [t`Entidad`, t`Representa una tabla de la base de datos: cada objeto es una fila y cada campo, una columna.`],
  dto: () => [t`DTO`, t`Objeto de transferencia de datos: la forma exacta de los datos que entran o salen por la API. Separa lo que ve el cliente de lo que hay en la base de datos.`],
  mapper: () => [t`Conversor`, t`Convierte una entidad en un DTO o al revés.`],
  client: () => [t`Cliente de otra API`, t`Llama a otro servidor por HTTP y trae sus datos.`],
  handler: () => [t`Manejador de errores`, t`Convierte las excepciones en respuestas HTTP con su código, por ejemplo 404.`],
  exception: () => [t`Excepción`, t`Un error con nombre propio que el código lanza cuando algo no se puede hacer.`],
  config: () => [t`Configuración`, t`Prepara piezas que usa el resto de la aplicación: clientes HTTP, seguridad, beans.`],
  app: () => [t`Arranque`, t`El punto de entrada: arranca la aplicación.`],
  middleware: () => [t`Middleware`, t`Se ejecuta antes de los endpoints: lee el JSON, comprueba la sesión, registra peticiones…`],
  routes: () => [t`Rutas`, t`Define qué URL atiende cada función.`],
  model: () => [t`Modelo`, t`Describe la forma de los datos que se guardan.`],
  other: () => [t`Otro`, t`Código de apoyo.`],
};
const roleInfo = (role) => { const [name, what] = (ROLE[role] || ROLE.other)(); return { role, roleName: name, what }; };

/** Glosario para quien empieza: cada término con una frase. */
function glossary() {
  return [
    ['endpoint', t`Endpoint`, t`Una dirección de tu API con su método, por ejemplo POST /api/pedidos. Es lo que llama el frontend o Postman.`],
    ['method', t`Método HTTP`, t`GET lee, POST crea, PUT o PATCH modifica y DELETE borra.`],
    ['dto', t`DTO`, t`La forma de los datos que viajan por la API. Un «Request» es lo que entra y un «Response», lo que sale.`],
    ['entity', t`Entidad`, t`Una clase que se guarda como tabla en la base de datos.`],
    ['controller', t`Controlador`, t`La puerta de entrada de cada endpoint: recibe, valida y responde.`],
    ['service', t`Servicio`, t`Donde vive la lógica: calcula, decide y coordina.`],
    ['repository', t`Repositorio`, t`El que lee y escribe en la base de datos.`],
    ['status', t`Código de estado`, t`El número de la respuesta: 200 bien, 201 creado, 204 sin contenido, 400 datos incorrectos, 404 no existe, 500 fallo del servidor.`],
    ['validation', t`Validación`, t`Comprobar los datos que llegan antes de usarlos (campos obligatorios, emails, mínimos).`],
    ['injection', t`Inyección de dependencias`, t`Spring crea los componentes y se los pasa a quien los necesita por el constructor.`],
  ].map(([id, term, text]) => ({ id, term, text }));
}

const RULE_TEXT = {
  NotNull: () => t`obligatorio`, NotBlank: () => t`obligatorio y no vacío`, NotEmpty: () => t`no vacío`, Email: () => t`debe ser un email`,
  Positive: () => t`mayor que 0`, PositiveOrZero: () => t`0 o más`, Negative: () => t`menor que 0`, Past: () => t`fecha pasada`, Future: () => t`fecha futura`,
  Pattern: () => t`debe cumplir un formato`, Valid: () => t`se valida por dentro`,
};
function fieldRules(annos) {
  const out = [];
  for (const m of String(annos || '').matchAll(/@(\w+)(?:\s*\(([^)]*)\))?/g)) {
    const [, name, args = ''] = m;
    if (RULE_TEXT[name]) out.push(RULE_TEXT[name]());
    else if (name === 'Min' || name === 'DecimalMin') out.push(t`mínimo ${(/-?\d+(\.\d+)?/.exec(args) || [''])[0]}`);
    else if (name === 'Max' || name === 'DecimalMax') out.push(t`máximo ${(/-?\d+(\.\d+)?/.exec(args) || [''])[0]}`);
    else if (name === 'Size') out.push(t`longitud entre ${(/min\s*=\s*(\d+)/.exec(args) || [, '0'])[1]} y ${(/max\s*=\s*(\d+)/.exec(args) || [, '∞'])[1]}`);
  }
  return out;
}

const STATUS_NAME = { OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, UNPROCESSABLE_ENTITY: 422, INTERNAL_SERVER_ERROR: 500 };
const statusOf = (text) => { const m = /HttpStatus\.(\w+)/.exec(text || ''); return m ? STATUS_NAME[m[1]] || null : (/\b([1-5]\d\d)\b/.exec(text || '') || [])[1] ? Number(/\b([1-5]\d\d)\b/.exec(text)[1]) : null; };

// Métodos que Spring Data ya da hechos: no están en tu código, pero hablan con la base de datos.
const SPRING_DATA = /^(findAll|findById|findAllById|save|saveAll|saveAndFlush|delete|deleteById|deleteAll|deleteAllById|count|existsById|flush|getReferenceById|getById)$/;
const DERIVED = /^(find|read|get|query|search|stream|count|exists|delete|remove)(?:First\d*|Top\d*|Distinct)?(?:All)?By(.+)$/;
function dbVerb(name) {
  if (/^findById|^getReferenceById|^getById/.test(name)) return t`busca por id`;
  if (/^findAll/.test(name)) return t`lee todos`;
  if (/^save/.test(name)) return t`guarda`;
  if (/^delete|^remove/.test(name)) return t`borra`;
  if (/^count/.test(name)) return t`cuenta`;
  if (/^exists/.test(name)) return t`comprueba si existe`;
  const d = DERIVED.exec(name);
  if (d) return t`busca por ${derivedProps(d[2]).join(', ')}`;
  return t`consulta`;
}
// «NombreAndEdadGreaterThanOrderByFechaDesc» → ['nombre', 'edad']
const OPS = /(IgnoreCase|AllIgnoreCase|GreaterThanEqual|GreaterThan|LessThanEqual|LessThan|Between|IsNotNull|IsNull|NotNull|Null|NotLike|Like|StartingWith|EndingWith|Containing|NotIn|In|IsNot|Not|IsTrue|True|IsFalse|False|Before|After|Equals|Is|Exists|Regex|Within|Near)$/;
function derivedProps(expr) {
  const body = expr.replace(/OrderBy.*$/, '');
  return body.split(/And|Or/).filter(Boolean).map((p) => { let x = p; for (let i = 0; i < 3; i++) x = x.replace(OPS, ''); return x.charAt(0).toLowerCase() + x.slice(1); }).filter(Boolean);
}

// ───────────────────────── Spring
function springRole(cls, idx) {
  const a = cls.annos || '';
  const has = (n) => new RegExp('@' + n + '\\b').test(a);
  if (has('SpringBootApplication')) return 'app';
  if (has('RestControllerAdvice') || has('ControllerAdvice')) return 'handler';
  if (has('RestController') || has('Controller')) return 'controller';
  if (has('Entity') || has('Document')) return 'entity';
  if (has('Repository') || (cls.kind === 'interface' && /extends\s+\w*(Jpa|Crud|PagingAndSorting|Mongo|Reactive\w*)Repository/.test(cls.src))) return 'repository';
  if (has('FeignClient') || /Client$/.test(cls.name) || /\b(RestTemplate|WebClient|RestClient)\b/.test(cls.src) && !has('Configuration')) return 'client';
  if (has('Service')) return 'service';
  if (/Mapper$/.test(cls.name)) return 'mapper';
  if (has('Configuration')) return 'config';
  if (/extends\s+(Runtime)?Exception\b/.test(cls.src)) return 'exception';
  if (cls.kind === 'record' || /(Dto|DTO|Request|Response|Payload|Form)$/.test(cls.name) || /\.dtos?$/.test(cls.pkg)) return 'dto';
  if (has('Component')) return /Service$/.test(cls.name) ? 'service' : 'other';
  void idx;
  return 'other';
}

const firstType = (type) => spring.simpleTypes(type || '')[0] || null;
/** Tipo útil de un retorno: ResponseEntity<List<X>> → «lista de X». */
function describeType(type) {
  if (!type || type === 'void') return { text: t`nada`, cls: null, list: false };
  let tpe = type.replace(/\s+/g, '');
  for (let i = 0; i < 3; i++) { const m = /^(?:ResponseEntity|Optional|Mono|CompletableFuture)<(.+)>$/.exec(tpe); if (m) tpe = m[1]; }
  const list = /^(?:java\.util\.)?(?:List|Set|Collection|Iterable|Page|Flux|Slice)<(.+)>$/.exec(tpe);
  const inner = list ? list[1] : tpe;
  const cls = inner.split('.').pop().replace(/<.*$/, '');
  if (/^(Map|HashMap)</.test(inner) || /^Map$/.test(cls)) return { text: list ? t`lista de objetos JSON` : t`un objeto JSON`, cls: null, list: !!list };
  if (/^\?$|^Object$|^Void$/.test(cls)) return { text: t`una respuesta sin tipo definido`, cls: null, list: !!list };
  return { text: list ? t`una lista de ${cls}` : cls, cls, list: !!list };
}

function springMap(root, F) {
  const idx = spring.indexSpring(root);
  const classes = [...idx.classes.values()];
  const role = new Map(classes.map((c) => [c.name, springRole(c, idx)]));
  // Excepción → código, según los @ExceptionHandler
  const handled = new Map();
  for (const c of classes) {
    if (role.get(c.name) !== 'handler') continue;
    for (const m of c.members) {
      const ex = /@ExceptionHandler\s*\(\s*\{?\s*([\w.]+)\.class/.exec(m.annos || '');
      if (!ex) continue;
      const status = statusOf(/@ResponseStatus\s*\(([^)]*)\)/.exec(m.annos || '')?.[1]) || statusOf(m.body) || 500;
      handled.set(ex[1].split('.').pop(), { status, by: c.name + '.' + m.name, file: c.rel, line: m.line });
    }
  }
  const fieldOf = (cls, name) => cls.fields.find((f) => f.name === name);
  const isRepo = (name) => role.get(name) === 'repository';

  // Qué hace cada método: llamadas a otros componentes (por campos inyectados), base de datos, APIs externas, DTO que crea.
  const methodInfo = new Map();
  function analyze(cls, m) {
    const key = cls.name + '.' + m.name;
    if (methodInfo.has(key)) return methodInfo.get(key);
    const info = { key, cls: cls.name, name: m.name, file: cls.rel, line: m.line, endLine: m.endLine || m.line, returns: m.type, params: spring.splitParams(m.params || ''), calls: [], db: [], external: [], creates: [], throws: [], notes: [], order: [] };
    methodInfo.set(key, info);
    const body = m.body || '';
    const seen = new Set();
    const add = (owner, method, at) => {
      const field = fieldOf(cls, owner);
      const targetName = field ? firstType(field.type) : null;
      const target = targetName && idx.classes.get(targetName);
      if (!target) return;
      const k = target.name + '.' + method;
      if (seen.has(k)) return;
      seen.add(k);
      if (isRepo(target.name)) {
        const declared = target.members.find((x) => x.kind === 'method' && x.name === method);
        const d = { repo: target.name, method, verb: dbVerb(method), file: target.rel, line: declared ? declared.line : target.line, builtin: !declared && SPRING_DATA.test(method) };
        info.db.push(d); info.order.push({ at, db: d });
      } else {
        const c = target.members.some((x) => x.kind === 'method' && x.name === method) ? { target: k } : { target: k, missing: true };
        info.calls.push(c); info.order.push({ at, call: c });
      }
    };
    for (const c of body.matchAll(/\b(\w+)\s*\.\s*(\w+)\s*\(/g)) add(c[1], c[2], c.index);
    for (const c of body.matchAll(/\b(\w+)::(\w+)/g)) add(c[1], c[2], c.index);
    // APIs externas: RestTemplate, WebClient, RestClient
    for (const c of body.matchAll(/\.\s*(getForObject|getForEntity|postForObject|postForEntity|put|patchForObject|delete|exchange)\s*\(\s*"([^"]+)"/g)) {
      const verb = /^get/.test(c[1]) ? 'GET' : /^post/.test(c[1]) ? 'POST' : /^put/.test(c[1]) ? 'PUT' : /^patch/.test(c[1]) ? 'PATCH' : /^delete/.test(c[1]) ? 'DELETE' : (/HttpMethod\.(\w+)/.exec(body.slice(c.index, c.index + 300)) || [, 'GET'])[1];
      const x = { method: verb, url: c[2], dto: (/(\w+)\.class/.exec(body.slice(c.index, c.index + 300)) || [])[1] || null };
      info.external.push(x); info.order.push({ at: c.index, external: x });
    }
    for (const c of body.matchAll(/\.\s*(get|post|put|patch|delete)\s*\(\s*\)\s*\.\s*uri\s*\(\s*"([^"]+)"/g)) {
      const x = { method: c[1].toUpperCase(), url: c[2], dto: (/bodyToMono\s*\(\s*(\w+)\.class/.exec(body.slice(c.index, c.index + 400)) || [])[1] || null };
      info.external.push(x); info.order.push({ at: c.index, external: x });
    }
    info.order.sort((a, b) => a.at - b.at);
    for (const c of body.matchAll(/\bnew\s+(\w+)\s*\(/g)) if (role.get(c[1]) === 'dto' || role.get(c[1]) === 'entity') info.creates.push(c[1]);
    for (const c of body.matchAll(/\bnew\s+(\w+(?:Exception|Error|NoEncontrad\w*|NotFound\w*)|\w+)\s*\(/g)) {
      const ex = idx.classes.get(c[1]);
      if ((ex && role.get(c[1]) === 'exception') || /Exception$/.test(c[1])) {
        if (/\bthrow\s+$|orElseThrow\s*\(\s*\(\s*\)\s*->\s*$/.test(body.slice(Math.max(0, c.index - 40), c.index))) info.throws.push(c[1]);
      }
    }
    if (/\.findById\s*\([^)]*\)\s*\.get\s*\(\s*\)/.test(body)) info.throws.push('NoSuchElementException');
    if (/\.orElse\s*\(\s*null\s*\)/.test(body)) info.notes.push('null');
    info.creates = [...new Set(info.creates)];
    info.throws = [...new Set(info.throws)];
    return info;
  }
  const byKey = (k) => { const [c, m] = k.split('.'); const cls = idx.classes.get(c); const mem = cls && cls.members.find((x) => x.kind === 'method' && x.name === m); return cls && mem ? analyze(cls, mem) : null; };
  for (const c of classes) for (const m of c.members) if (m.kind === 'method') analyze(c, m);

  // Componentes
  const components = classes.map((c) => {
    const r = role.get(c.name);
    const methods = c.members.filter((m) => m.kind === 'method' && !/^(get|set|is)[A-Z]/.test(m.name) && m.name !== c.name).map((m) => methodInfo.get(c.name + '.' + m.name)).filter(Boolean);
    const deps = c.fields.map((f) => firstType(f.type)).filter((n) => n && idx.classes.has(n) && n !== c.name);
    return { id: c.name, name: c.name, file: c.rel, line: c.line, ...roleInfo(r), kind: c.kind, deps: [...new Set(deps)], methods: methods.map((m) => m.key) };
  });
  const usedBy = new Map();
  for (const c of components) for (const d of c.deps) (usedBy.get(d) || usedBy.set(d, []).get(d)).push(c.id);
  for (const c of components) c.usedBy = usedBy.get(c.id) || [];

  // Endpoints con su cadena de llamadas
  const endpoints = idx.endpoints.map((ep) => {
    const handler = byKey(ep.handler);
    const inputs = ep.params.map((p) => {
      const where = /@PathVariable\b/.test(p.annos) ? 'path' : /@RequestBody\b/.test(p.annos) ? 'body' : /@RequestParam\b/.test(p.annos) ? 'query' : /@RequestHeader\b/.test(p.annos) ? 'header' : 'other';
      const type = firstType(p.type);
      return { name: p.name, type: p.type, where, dto: type && role.get(type) === 'dto' ? type : null, entity: type && role.get(type) === 'entity' ? type : null, validated: /@Valid(ated)?\b/.test(p.annos) };
    }).filter((p) => p.where !== 'other');
    const out = describeType(ep.member.type);
    const outRole = out.cls && role.get(out.cls);
    // Código de respuesta: ResponseEntity.status(...), @ResponseStatus, void → 200 sin cuerpo.
    const explicit = statusOf((/@ResponseStatus\s*\(([^)]*)\)/.exec(ep.member.annos) || [])[1]) || statusOf((/ResponseEntity\s*\.\s*status\s*\(([^)]*)\)/.exec(ep.member.body || '') || [])[1])
      || (/ResponseEntity\s*\.\s*created\s*\(/.test(ep.member.body || '') ? 201 : /ResponseEntity\s*\.\s*noContent\s*\(/.test(ep.member.body || '') ? 204 : null);
    const steps = [];
    const errors = new Map();
    const visit = (info, depth, seen) => {
      if (!info || depth > 6 || seen.has(info.key)) return;
      seen.add(info.key);
      const r = role.get(info.cls);
      steps.push({ depth, kind: 'method', key: info.key, cls: info.cls, method: info.name, ...roleInfo(r), file: info.file, line: info.line, returns: describeType(info.returns).text, creates: info.creates });
      for (const ex of info.throws) {
        const h = handled.get(ex);
        errors.set(ex, { exception: ex, status: h ? h.status : 500, by: h ? h.by : null, from: info.key, handled: !!h });
      }
      if (info.notes.includes('null')) errors.set('null', { exception: null, status: 200, nullBody: true, from: info.key });
      // En el orden en que aparecen en el código: así se lee como una receta.
      for (const o of info.order) {
        if (o.db) steps.push({ depth: depth + 1, kind: 'db', key: o.db.repo + '.' + o.db.method, cls: o.db.repo, method: o.db.method, ...roleInfo('repository'), verb: o.db.verb, builtin: o.db.builtin, file: o.db.file, line: o.db.line });
        else if (o.external) steps.push({ depth: depth + 1, kind: 'external', method: o.external.method, url: o.external.url, dto: o.external.dto, ...roleInfo('client'), file: info.file, line: info.line });
        else if (o.call.missing) steps.push({ depth: depth + 1, kind: 'missing', key: o.call.target, cls: o.call.target.split('.')[0], method: o.call.target.split('.')[1], ...roleInfo(role.get(o.call.target.split('.')[0])), file: info.file, line: info.line });
        else visit(byKey(o.call.target), depth + 1, seen);
      }
    };
    visit(handler, 0, new Set());
    const status = explicit || (out.cls || out.list ? 200 : ep.member.type === 'void' ? 200 : 200);
    return {
      id: ep.method + ' ' + ep.path, method: ep.method, path: ep.path, handler: ep.handler, file: ep.file, line: ep.line,
      inputs, output: { ...out, role: outRole || null, status, empty: ep.member.type === 'void' }, steps, errors: [...errors.values()],
      summary: endpointSummary({ method: ep.method, inputs, out, outRole, status, empty: ep.member.type === 'void', steps }),
    };
  });

  // DTO y entidades con sus campos
  const dtos = classes.filter((c) => role.get(c.name) === 'dto').map((c) => {
    const inEndpoints = endpoints.filter((e) => e.inputs.some((i) => i.dto === c.name)).map((e) => e.id);
    const outEndpoints = endpoints.filter((e) => e.output.cls === c.name).map((e) => e.id);
    const createdIn = [...methodInfo.values()].filter((m) => m.creates.includes(c.name)).map((m) => m.key);
    const mentioned = classes.some((o) => o.name !== c.name && new RegExp('\\b' + c.name + '\\b').test(o.src));
    const fromExternal = [...methodInfo.values()].filter((m) => m.external.some((x) => x.dto === c.name)).map((m) => m.key);
    return {
      name: c.name, file: c.rel, line: c.line, kind: /Request$|Form$|Payload$/.test(c.name) || inEndpoints.length ? 'request' : /Response$/.test(c.name) || outEndpoints.length ? 'response' : fromExternal.length ? 'external' : 'dto', fromExternal,
      fields: c.fields.filter((f) => !/\bstatic\b/.test(f.annos + ' ' + (f.type || ''))).map((f) => ({ name: f.name, type: f.type, rules: fieldRules(f.annos) })),
      input: inEndpoints, output: outEndpoints, createdIn, unused: !mentioned,
    };
  });
  const entities = classes.filter((c) => role.get(c.name) === 'entity').map((c) => ({
    name: c.name, file: c.rel, line: c.line, table: (/@Table\s*\(\s*name\s*=\s*"([^"]+)"/.exec(c.annos) || [])[1] || null,
    fields: c.fields.map((f) => {
      const rel = /@(ManyToOne|OneToOne|OneToMany|ManyToMany)\b/.exec(f.annos || '');
      return { name: f.name, type: f.type, id: /@Id\b/.test(f.annos || ''), relation: rel ? { kind: rel[1], target: spring.simpleTypes(f.type).filter((n) => n !== 'List' && n !== 'Set').pop() } : null };
    }),
  }));
  const externals = [...methodInfo.values()].flatMap((m) => m.external.map((x) => ({ ...x, from: m.key, file: m.file, line: m.line })));

  return { framework: 'spring', components, endpoints, dtos, entities, externals, findings: F ? springAiFindings(idx, { role, endpoints, dtos, methodInfo, classes }, F) : [] };
}

/** Frase en lenguaje sencillo de lo que hace un endpoint, de principio a fin. */
function endpointSummary({ method, inputs, out, outRole, status, empty, steps }) {
  const parts = [];
  const body = inputs.find((i) => i.where === 'body');
  const pathIn = inputs.filter((i) => i.where === 'path').map((i) => i.name);
  const queryIn = inputs.filter((i) => i.where === 'query').map((i) => i.name);
  // Un DTO se nombra; unos campos sueltos (Express, Next.js, Flask) se enumeran.
  const bodyText = !body ? null : body.dto || body.entity ? t`un ${body.dto || body.entity} en el cuerpo` : body.fields && body.fields.length ? t`los campos ${body.fields.join(', ')} en el cuerpo` : t`datos JSON en el cuerpo`;
  const recv = [bodyText, pathIn.length ? t`${pathIn.join(', ')} en la URL` : null, queryIn.length ? t`${queryIn.join(', ')} como parámetro` : null].filter(Boolean);
  parts.push(recv.length ? t`Recibe ${recv.join(t` y `)}.` : t`No recibe datos.`);
  const db = steps.filter((s) => s.kind === 'db').map((s) => t`${s.verb} (${s.cls}.${s.method})`);
  const ext = steps.filter((s) => s.kind === 'external').map((s) => `${s.method} ${s.url}`);
  const chain = steps.filter((s) => s.kind === 'method' && s.depth > 0).map((s) => `${s.cls}.${s.method}`);
  if (chain.length) parts.push(t`Pasa por ${chain.join(' → ')}.`);
  if (db.length) parts.push(t`En la base de datos: ${db.join(', ')}.`);
  if (ext.length) parts.push(t`Llama a otra API: ${ext.join(', ')}.`);
  parts.push(empty ? t`Responde ${status} sin contenido.` : t`Devuelve ${out.text} con código ${status}.`);
  if (outRole === 'entity') parts.push(t`Ojo: devuelve una entidad de la base de datos, no un DTO.`);
  void method;
  return parts.join(' ');
}

/** Errores típicos del código hecho con prisa (o por una IA) que compilan pero fallan al usarlo. */
function springAiFindings(idx, map, F) {
  const out = [];
  // Ruta duplicada: Spring no arranca («Ambiguous mapping»).
  const byRoute = new Map();
  for (const e of map.endpoints) (byRoute.get(e.id) || byRoute.set(e.id, []).get(e.id)).push(e);
  for (const [id, list] of byRoute) {
    if (list.length < 2) continue;
    const [first, ...rest] = list;
    for (const dup of rest) {
      out.push(F('correctness', 'backend-duplicate-route', 'fail', dup.file, dup.line, id + '|' + dup.handler, {
        confidence: 97, title: t`${id} está definido dos veces`,
        why: t`${first.handler} y ${dup.handler} atienden la misma ruta con el mismo método. Spring no arranca («Ambiguous mapping»). Suele pasar cuando una IA añade un método nuevo sin ver que ya existía.`,
        action: t`Quedarse con uno de los dos o cambiar la ruta de uno (por ejemplo, ${id.split(' ')[1]}/detalle).`,
        tech: t`Mapeo ambiguo: ${first.handler} y ${dup.handler}`, evidence: [t`${first.file}:${first.line} ${first.handler}`, t`${dup.file}:${dup.line} ${dup.handler}`],
        related: [{ file: first.file, line: first.line }],
      }));
    }
  }
  // Consultas derivadas (findByX) con atributos que la entidad no tiene: Spring no arranca.
  for (const c of map.classes) {
    if (map.role.get(c.name) !== 'repository') continue;
    const entityName = (/Repository\s*<\s*(\w+)/.exec(c.src) || [])[1];
    const ent = entityName && idx.entities.get(entityName);
    if (!ent) continue;
    const names = ent.fields.map((f) => f.name);
    for (const m of c.members) {
      if (m.kind !== 'method' || /@Query\b/.test(m.annos || '')) continue;
      const d = DERIVED.exec(m.name);
      if (!d) continue;
      for (const prop of derivedProps(d[2])) {
        if (names.includes(prop)) continue;
        // Propiedad anidada: «clienteNombre» → cliente.nombre
        const nested = names.find((n) => prop.startsWith(n) && prop.length > n.length);
        const sub = nested && ent.fields.find((f) => f.name === nested);
        const target = sub && idx.entities.get(spring.simpleTypes(sub.type).pop());
        if (target) { const rest = prop.slice(nested.length); const restName = rest.charAt(0).toLowerCase() + rest.slice(1); if (target.fields.some((f) => f.name === restName)) continue; }
        const near = spring.closest(prop, names);
        out.push(F('correctness', 'spring-derived-query', 'fail', c.rel, m.line, c.name + '.' + m.name + ':' + prop, {
          confidence: 95, title: t`${c.name}.${m.name} busca por «${prop}», pero ${ent.name} no tiene ese atributo`,
          why: t`Spring Data crea la consulta a partir del nombre del método. Si el atributo no existe en la entidad, la aplicación no arranca («No property '${prop}' found»). Es un error frecuente cuando una IA inventa nombres.`,
          action: near ? t`Renombrar el método usando «${near}» en lugar de «${prop}».` : t`Usar uno de los atributos de ${ent.name}: ${names.join(', ')}.`,
          tech: t`Consulta derivada ${m.name}`, evidence: [t`Atributos de ${ent.name}: ${names.join(', ')}`], related: [{ file: ent.rel, line: ent.line }],
        }));
      }
    }
  }
  // DTO que nadie usa: código sobrante.
  for (const d of map.dtos) {
    if (!d.unused) continue;
    out.push(F('maintainability', 'backend-unused-dto', 'risk', d.file, d.line, d.name, {
      confidence: 85, title: t`El DTO ${d.name} no se usa en ningún sitio`,
      why: t`Ningún controlador, servicio ni otra clase lo menciona. Suele quedar cuando una IA genera piezas «por si acaso» o cambia de idea a mitad de camino. Confunde a quien lee el código.`,
      action: t`Borrarlo si no hace falta, o usarlo donde se pensó usar.`, tech: t`${d.name} sin referencias`, evidence: [d.file],
    }));
  }
  // Cliente HTTP sin tiempo de espera: si la otra API no responde, tu endpoint se queda colgado.
  for (const c of map.classes) {
    const m = /new\s+RestTemplate\s*\(\s*\)/.exec(c.src);
    if (!m) continue;
    const line = c.src.slice(0, m.index).split('\n').length;
    out.push(F('performance', 'spring-resttemplate-timeout', 'risk', c.rel, line, c.name, {
      confidence: 90, title: t`${c.name} llama a otra API sin tiempo de espera`,
      why: t`Un RestTemplate creado con new RestTemplate() espera sin límite. Si la otra API tarda o no responde, tu endpoint se queda colgado y ocupa un hilo del servidor.`,
      action: t`Crear el RestTemplate con RestTemplateBuilder y fijar setConnectTimeout y setReadTimeout (por ejemplo, 2 y 5 segundos).`,
      tech: t`new RestTemplate() en ${c.name}`, evidence: [t`${c.rel}:${line}`],
    }));
  }
  // Endpoint que responde 200 con cuerpo vacío cuando no encuentra el registro (orElse(null)).
  for (const e of map.endpoints) {
    if (!e.errors.some((x) => x.nullBody)) continue;
    out.push(F('correctness', 'backend-null-response', 'risk', e.file, e.line, e.id, {
      confidence: 85, title: t`${e.id} responde 200 con el cuerpo vacío si no encuentra el registro`,
      why: t`orElse(null) devuelve null y Spring responde 200 sin contenido. Quien llama cree que funcionó y no sabe que el registro no existe.`,
      action: t`Lanzar una excepción con orElseThrow y convertirla en 404 en el manejador de errores.`, tech: t`orElse(null) en la cadena de ${e.handler}`, evidence: [t`${e.file}:${e.line}`],
    }));
  }
  // Controlador que llama a un método que no existe en su servicio (la IA lo «imaginó»).
  for (const info of map.methodInfo.values()) {
    for (const c of info.calls) {
      if (!c.missing) continue;
      const [cls, method] = c.target.split('.');
      const target = idx.classes.get(cls);
      if (!target || /extends\s+\w+/.test(target.src.slice(0, 400)) || target.kind === 'interface') continue;
      out.push(F('correctness', 'backend-missing-method', 'fail', info.file, info.line, info.key + '->' + c.target, {
        confidence: 90, title: t`${info.key} llama a ${c.target}, que no existe`,
        why: t`${cls} no tiene un método «${method}». El código no compila. Suele pasar cuando una IA da por hecho que existe un método.`,
        action: t`Crear ${method} en ${cls} o llamar al método que sí existe.`, tech: t`Llamada a un método inexistente`, evidence: [t`Métodos de ${cls}: ${target.members.filter((x) => x.kind === 'method').map((x) => x.name).join(', ')}`],
        related: [{ file: target.rel, line: target.line }],
      }));
    }
  }
  return out;
}

// ───────────────────────── Express
const EXPRESS_DIR_ROLE = [[/(^|\/)controllers?\//, 'controller'], [/(^|\/)services?\//, 'service'], [/(^|\/)(repositor(y|ies)|daos?|db)\//, 'repository'], [/(^|\/)models?\//, 'model'], [/(^|\/)middlewares?\//, 'middleware'], [/(^|\/)routes?\//, 'routes'], [/(^|\/)(dtos?|schemas?|validators?)\//, 'dto'], [/(^|\/)(clients?|api|integrations?)\//, 'client'], [/(^|\/)config\//, 'config']];
/** Campos que se leen del cuerpo: req.body.x y const { a, b } = req.body. */
function bodyFieldsIn(text) {
  const names = new Set();
  for (const m of text.matchAll(/\breq\.body\.(\w+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*req\.body\b/g)) for (const part of m[1].split(',')) { const n = part.trim().split(/[:=\s]/)[0]; if (/^\w+$/.test(n)) names.add(n); }
  return [...names];
}
const roleByPath = (rel) => (EXPRESS_DIR_ROLE.find(([re]) => re.test(rel)) || [, 'other'])[1];

function expressMap(root, F) {
  const idx = express.indexExpress(root);
  const byRel = new Map(idx.files.map((f) => [f.rel, f]));
  // Funciones con nombre de cada archivo: function x(), const x = (…) =>, exports.x =, x(...) { en objetos/clases.
  const fnIndex = new Map();
  const functionsOf = (f) => {
    if (fnIndex.has(f.rel)) return fnIndex.get(f.rel);
    const fns = new Map();
    const re = /(?:async\s+)?function\s+(\w+)\s*\(|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>|(?:exports|module\.exports)\.(\w+)\s*=\s*(?:async\s*)?(?:function|\(|\w+\s*=>)|^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/gm;
    for (const m of f.src.matchAll(re)) {
      const name = m[1] || m[2] || m[3] || m[4];
      if (!name || /^(if|for|while|switch|catch|function|return)$/.test(name)) continue;
      const start = f.src.indexOf('{', m.index + m[0].length - 1);
      let depth = 0, i = start;
      if (start === -1) continue;
      for (; i < f.src.length; i++) { if (f.src[i] === '{') depth++; else if (f.src[i] === '}' && --depth === 0) break; }
      if (!fns.has(name)) fns.set(name, { name, line: f.src.slice(0, m.index).split('\n').length, body: f.src.slice(start, i + 1) });
    }
    fnIndex.set(f.rel, fns);
    return fns;
  };
  const resolveImport = (f, local) => {
    const spec = f.imports.get(local);
    if (!spec || !spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(f.abs), spec);
    for (const c of [base, base + '.js', base + '.ts', base + '.mjs', base + '.cjs', path.join(base, 'index.js'), path.join(base, 'index.ts')]) {
      const rel = path.relative(root, c).split(path.sep).join('/');
      if (byRel.has(rel)) return byRel.get(rel);
    }
    return null;
  };
  const DB_CALL = /\b(\w+)\.(findMany|findUnique|findFirst|findOne|findById|findByPk|findAll|find|create|insertOne|insertMany|updateOne|updateMany|update|upsert|deleteOne|deleteMany|delete|destroy|save|query|execute|aggregate|count)\s*\(/g;
  const visit = (f, body, depth, steps, seen, fromLine) => {
    if (depth > 5) return;
    for (const x of body.matchAll(/\b(?:fetch|axios(?:\.(get|post|put|patch|delete))?)\s*\(\s*[`'"](https?:\/\/[^`'"]+)[`'"]/g)) steps.push({ depth, kind: 'external', method: (x[1] || 'GET').toUpperCase(), url: x[2], ...roleInfo('client'), file: f.rel, line: fromLine });
    for (const x of body.matchAll(DB_CALL)) {
      if (/^(res|req|console|JSON|Object|Array|Math|Promise|router|app|this)$/.test(x[1])) continue;
      // find, delete, count, update y create también existen en arrays, Map y Set (cache.delete, lista.find):
      // con esos verbos solo cuenta como base de datos si el objeto lo parece (db, prisma, un modelo con mayúscula…).
      const parent = (/(\w+)\.$/.exec(body.slice(Math.max(0, x.index - 40), x.index)) || [])[1] || ''; // db.pedido.create
      const dbLike = (n) => /db|prisma|model|repo|collection|knex|pool|client|sequelize|mongoose|table|store$/i.test(n);
      if (/^(find|delete|count|update|create)$/.test(x[2]) && !/^[A-Z]/.test(x[1]) && !dbLike(x[1]) && !dbLike(parent)) continue;
      steps.push({ depth, kind: 'db', key: x[1] + '.' + x[2], cls: x[1], method: x[2], ...roleInfo('repository'), verb: dbVerb(x[2]), file: f.rel, line: fromLine });
    }
    for (const x of body.matchAll(/\b(\w+)\.(\w+)\s*\(|(?<![.\w])(\w+)\s*\(/g)) {
      const owner = x[1], name = x[2] || x[3];
      if (!name || /^(require|if|for|while|switch|catch|return|await|async|function|res|req|next|json|status|send)$/.test(name)) continue;
      let target = null, fn = null;
      if (owner) { target = resolveImport(f, owner); fn = target && functionsOf(target).get(name); }
      else { fn = functionsOf(f).get(name); target = fn ? f : null; if (!fn) for (const [local] of f.imports) { if (local === name) { const tf = resolveImport(f, local); fn = tf && (functionsOf(tf).get(name) || functionsOf(tf).get('default')); target = tf; } } }
      if (!fn || !target) continue;
      const key = target.rel + '#' + fn.name;
      if (seen.has(key)) continue;
      seen.add(key);
      steps.push({ depth, kind: 'method', key, cls: path.basename(target.rel).replace(/\.\w+$/, ''), method: fn.name, ...roleInfo(roleByPath(target.rel)), file: target.rel, line: fn.line });
      visit(target, fn.body, depth + 1, steps, seen, fn.line);
    }
  };
  const endpoints = idx.endpoints.map((ep) => {
    const f = idx.files.find((x) => x.rel === ep.file);
    const steps = [{ depth: 0, kind: 'method', key: ep.file + '#' + ep.line, cls: path.basename(ep.file).replace(/\.\w+$/, ''), method: ep.method + ' ' + ep.path, ...roleInfo(roleByPath(ep.file) === 'other' ? 'routes' : roleByPath(ep.file)), file: ep.file, line: ep.line }];
    // router.get('/', ctrl.listar): la ruta pasa la función sin llamarla. Se sigue igual que una llamada.
    if (f) visit(f, ep.body.replace(/\b(\w+)\.(\w+)\b(?!\s*\()/g, (all, owner, name) => (f.imports.has(owner) ? `${owner}.${name}()` : all)), 1, steps, new Set(), ep.line);
    const all = ep.body + steps.map((s) => (s.kind === 'method' && fnIndex.get(s.file)?.get(s.method)?.body) || '').join('\n');
    const statuses = [...new Set([...all.matchAll(/\.(?:status|sendStatus)\s*\(\s*(\d{3})/g)].map((m) => Number(m[1])))];
    const status = statuses.find((s) => s < 400) || (/\.(json|send)\s*\(/.test(all) ? 200 : statuses[0] || 200);
    const errors = statuses.filter((s) => s >= 400).map((s) => ({ exception: null, status: s, handled: true }));
    const inputs = [
      ...[...ep.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], type: 'string', where: 'path' })),
      // Los campos del cuerpo se buscan en toda la cadena: a menudo los lee el controlador, no la ruta.
      ...(bodyFieldsIn(all).length ? [{ name: 'body', type: '{ ' + bodyFieldsIn(all).join(', ') + ' }', where: 'body', fields: bodyFieldsIn(all) }] : []),
      ...[...new Set([...all.matchAll(/req\.query\.(\w+)/g)].map((m) => m[1]))].map((n) => ({ name: n, type: 'string', where: 'query' })),
    ];
    const out = { text: /\.json\s*\(/.test(all) ? t`un objeto JSON` : /\.send\s*\(/.test(all) ? t`texto o datos` : t`nada`, cls: null, list: false };
    return {
      id: ep.method + ' ' + ep.path, method: ep.method, path: ep.path, handler: ep.handler, file: ep.file, line: ep.line,
      inputs, output: { ...out, status, empty: out.cls == null && !/\.(json|send)\s*\(/.test(all) }, steps, errors,
      summary: endpointSummary({ method: ep.method, inputs, out, outRole: null, status, empty: false, steps }),
    };
  });
  const components = idx.files.filter((f) => !/\.(test|spec)\./.test(f.rel)).map((f) => ({
    id: f.rel, name: path.basename(f.rel), file: f.rel, line: 1, ...roleInfo(f.apps.size ? 'app' : f.routes.length ? 'routes' : roleByPath(f.rel)),
    deps: [...f.imports.values()].filter((s) => s.startsWith('.')).map((s) => { const r = resolveImport(f, [...f.imports].find(([, v]) => v === s)[0]); return r ? r.rel : null; }).filter(Boolean),
    methods: [...functionsOf(f).keys()],
  }));
  const usedBy = new Map();
  for (const c of components) for (const d of c.deps) (usedBy.get(d) || usedBy.set(d, []).get(d)).push(c.id);
  for (const c of components) c.usedBy = usedBy.get(c.id) || [];
  const findings = [];
  if (F) {
    const byRoute = new Map();
    for (const e of endpoints) (byRoute.get(e.id) || byRoute.set(e.id, []).get(e.id)).push(e);
    for (const [id, list] of byRoute) for (const dup of list.slice(1)) {
      findings.push(F('correctness', 'backend-duplicate-route', 'fail', dup.file, dup.line, id + '|' + dup.line, {
        confidence: 95, title: t`${id} está definido dos veces`,
        why: t`Express ejecuta solo la primera definición que encaja: ${list[0].file}:${list[0].line}. La segunda nunca se usa, aunque parezca que sí. Suele pasar cuando una IA añade una ruta sin ver que ya existía.`,
        action: t`Borrar una de las dos o cambiar su ruta.`, tech: t`Ruta duplicada`, evidence: list.map((e) => `${e.file}:${e.line}`), related: [{ file: list[0].file, line: list[0].line }],
      }));
    }
  }
  return { framework: 'express', components, endpoints, dtos: [], entities: [], externals: endpoints.flatMap((e) => e.steps.filter((s) => s.kind === 'external').map((s) => ({ method: s.method, url: s.url, from: e.id, file: s.file, line: s.line }))), findings };
}

/**
 * Mapa del backend del proyecto, o null si no se reconoce ningún backend (Spring Boot o Express).
 * @param F constructor de hallazgos (opcional): si se pasa, también se devuelven los errores típicos detectados.
 */
function backendMap(root, F) {
  let map = null;
  const H = { roleInfo, endpointSummary, dbVerb };
  // Orden: los frameworks más específicos primero (NestJS y Next.js también dependen de Express a menudo).
  const js = detectJs(root);
  if (spring.isSpringProject(root)) map = springMap(root, F);
  else if (js) map = jsMap(root, F, H, js);
  else if (express.isExpressProject(root)) map = expressMap(root, F);
  else map = pythonMap(root, F, H);
  if (!map) return null;
  map.glossary = glossary();
  map.baseUrl = guessTarget(root).url;
  addExamples(map);
  map.roles = Object.keys(ROLE).map((r) => roleInfo(r));
  return map;
}

/**
 * Petición de ejemplo para cada endpoint, lista para copiar en una terminal (curl), y la respuesta que se espera.
 * Los valores salen de los tipos y las reglas de cada campo; son de prueba, no datos reales.
 */
function sampleValue(name, type, rules = []) {
  const n = String(name || '').toLowerCase(), tp = String(type || '').toLowerCase();
  const min = rules.map((r) => /(-?\d+(?:\.\d+)?)/.exec(r)).find(Boolean);
  if (/bool/.test(tp)) return true;
  if (/(int|long|short|number|integer)\b|^int$/.test(tp) || /(^|_)id$|id$/.test(n) && !/str/.test(tp)) return min ? Math.max(1, Math.ceil(Number(min[1]))) : 1;
  if (/(float|double|decimal|bigdecimal)/.test(tp)) return min ? Number(min[1]) + 1 : 9.99;
  if (/date|time|instant/.test(tp)) return new Date().toISOString().slice(0, /time|instant/.test(tp) ? 19 : 10);
  if (/email/.test(n) || /email/.test(tp)) return t`ana@ejemplo.com`;
  if (/password|contrase/.test(n)) return 'Secreta123!';
  if (/^(nombre|name|first_?name)$/.test(n)) return 'Ana';
  if (/(url|web|link)/.test(n)) return t`https://ejemplo.com`;
  if (/(list|\[\]|set<)/.test(tp)) return [];
  return t`texto`;
}
function addExamples(map) {
  const dtos = new Map((map.dtos || []).map((d) => [d.name, d]));
  for (const e of map.endpoints) {
    const sample = (all, p) => encodeURIComponent(String(sampleValue(p, /(id|pk)$/i.test(p) ? 'int' : 'string')));
    // {id} en Spring, FastAPI y NestJS; :id en Express.
    let url = e.path.replace(/\{(\w+)\*?\}/g, sample).replace(/:(\w+)\??/g, sample);
    const query = e.inputs.filter((i) => i.where === 'query').map((i) => `${i.name}=${encodeURIComponent(String(sampleValue(i.name, i.type)))}`);
    if (query.length) url += '?' + query.join('&');
    const bodyIn = e.inputs.find((i) => i.where === 'body');
    let body = null;
    if (bodyIn) {
      const d = bodyIn.dto && dtos.get(bodyIn.dto);
      const fields = d ? d.fields.filter((f) => !f.readOnly).map((f) => [f.name, f.type, f.rules]) : (bodyIn.fields || []).map((f) => [f, 'string', []]);
      body = Object.fromEntries(fields.map(([n, tp, r]) => [n, sampleValue(n, tp, r)]));
    }
    const json = body ? JSON.stringify(body) : null;
    e.example = {
      method: e.method, path: url, body,
      curl: `curl -i -X ${e.method} '${map.baseUrl}${url}'` + (json ? ` -H 'Content-Type: application/json' -d '${json.replace(/'/g, "'\\''")}'` : ''),
      expect: e.output.status,
      errors: e.errors.filter((x) => x.status).map((x) => x.status),
    };
  }
}

module.exports = { backendMap, derivedProps, describeType, fieldRules };
void fs;
