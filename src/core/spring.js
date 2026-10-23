'use strict';
// Spring Boot: índice ligero del código Java (entities, controllers, @Query, DTO) y reglas estáticas que el
// compilador no ve. El mismo índice sirve al modo en vivo (springrun.js) para llevar cada error a su archivo y línea.
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');

const MAPPING = /@(Get|Post|Put|Delete|Patch|Request)Mapping\b/;
const SKIP_DIRS = new Set(['target', 'build', 'node_modules', '.git', '.idea', '.spectator', 'out']);

function isSpringProject(root) {
  for (const f of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
    try { if (/spring-boot/.test(fs.readFileSync(path.join(root, f), 'utf8'))) return f; } catch { /* no existe */ }
  }
  return null;
}

function javaFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name)); }
      else if (e.name.endsWith('.java')) out.push(path.join(dir, e.name));
    }
  };
  walk(path.join(root, 'src', 'main', 'java'));
  return out;
}

// Quita comentarios conservando saltos de línea (para que los números de línea sigan valiendo) y el texto de las cadenas.
function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '"') { const end = src.indexOf('"', i + 1); let j = i + 1; while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1; out += src.slice(i, j + 1); i = j + 1; void end; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const j = src.indexOf('*/', i + 2); const chunk = src.slice(i, j === -1 ? src.length : j + 2); out += chunk.replace(/[^\n]/g, ' '); i = j === -1 ? src.length : j + 2; continue; }
    out += c; i++;
  }
  return out;
}

const lineAt = (src, idx) => src.slice(0, idx).split('\n').length;
const literals = (s) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
const joinPath = (a, b) => ('/' + [a, b].filter(Boolean).join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

/** Lee desde el paréntesis de apertura en `from` hasta su cierre. */
function balanced(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '"') { i++; while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1; continue; }
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(from + 1, i);
  }
  return src.slice(from + 1);
}

/** Separa los miembros de una clase: anotaciones + declaración, con su línea. */
function members(src) {
  const out = [];
  const re = /((?:@\w+(?:\.\w+)*(?:\s*\((?:[^()"]|"(?:[^"\\]|\\.)*"|\([^()]*\))*\))?\s*)*)((?:public|protected|private|static|final|abstract|synchronized|default|\s)*)([\w.<>,?\[\]\s]+?)\s+(\w+)\s*(\(|=|;)/g;
  let m;
  while ((m = re.exec(src))) {
    const [, annos, mods, type, name, kind] = m;
    if (/^(return|new|else|throw|case)$/.test(type.trim()) || /\b(return|new|throw)\b/.test(type)) continue;
    const start = m.index + m[0].indexOf(type, annos.length + mods.length);
    const member = { annos, mods, type: type.trim().replace(/\s+/g, ' '), name, kind: kind === '(' ? 'method' : 'field', line: lineAt(src, start), annoLine: annos.trim() ? lineAt(src, m.index + annos.search(/@/)) : lineAt(src, start) };
    if (member.kind === 'method') {
      const open = m.index + m[0].length - 1;
      member.params = balanced(src, open);
      const after = src.indexOf(')', open + member.params.length);
      const brace = src.indexOf('{', after), semi = src.indexOf(';', after);
      if (brace !== -1 && (semi === -1 || brace < semi)) {
        let depth = 0, i = brace;
        for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
        member.body = src.slice(brace + 1, i);
        member.endLine = lineAt(src, i);
        re.lastIndex = i;
      }
    }
    out.push(member);
  }
  return out;
}

const annoArgs = (annos, name) => { const i = annos.search(new RegExp('@' + name + '\\b')); if (i === -1) return null; const p = annos.indexOf('(', i); const next = annos.slice(i + name.length + 1).search(/\S/); return p !== -1 && next !== -1 && annos[i + name.length + 1 + next] === '(' ? balanced(annos, p) : ''; };
const has = (annos, name) => new RegExp('@' + name + '\\b').test(annos);

/** Índice del proyecto Spring. Se reconstruye en cada llamada: es barato y siempre refleja el disco. */
function indexSpring(root) {
  const idx = { root, classes: new Map(), entities: new Map(), controllers: [], endpoints: [], queries: [], files: [] };
  for (const abs of javaFiles(root)) {
    let raw;
    try { raw = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const src = stripComments(raw);
    const pkg = (/^\s*package\s+([\w.]+)\s*;/m.exec(src) || [])[1] || '';
    const head = /((?:@\w+(?:\s*\((?:[^()"]|"(?:[^"\\]|\\.)*")*\))?\s*)*)(?:public\s+|abstract\s+|final\s+)*(class|interface|record|enum)\s+(\w+)/.exec(src);
    if (!head) continue;
    const [, classAnnos, kind, name] = head;
    const bodyStart = kind === 'record' ? src.indexOf('(', head.index + head[0].length - 1) : src.indexOf('{', head.index);
    const cls = { name, kind, pkg, fqn: pkg ? pkg + '.' + name : name, rel, line: lineAt(src, head.index + head[0].lastIndexOf(name)), annos: classAnnos, src, raw };
    if (kind === 'record') {
      const comps = balanced(src, bodyStart);
      cls.fields = splitParams(comps).map((p) => ({ ...p, line: lineAt(src, bodyStart + comps.indexOf(p.text) + 1) }));
      cls.members = members(src.slice(src.indexOf('{', bodyStart + comps.length)));
    } else {
      cls.members = members(src.slice(bodyStart + 1)).map((m) => ({ ...m, line: m.line + lineAt(src, bodyStart) - 1, annoLine: m.annoLine + lineAt(src, bodyStart) - 1, endLine: m.endLine && m.endLine + lineAt(src, bodyStart) - 1 }));
      cls.fields = cls.members.filter((m) => m.kind === 'field').map((m) => ({ name: m.name, type: m.type, annos: m.annos, line: m.line, annoLine: m.annoLine }));
    }
    idx.classes.set(name, cls);
    idx.files.push(rel);
    if (has(classAnnos, 'Entity')) idx.entities.set(name, cls);
    if (has(classAnnos, 'RestController') || has(classAnnos, 'Controller')) {
      idx.controllers.push(cls);
      const baseArgs = annoArgs(classAnnos, 'RequestMapping');
      const base = baseArgs != null ? (literals(baseArgs)[0] || '') : '';
      for (const m of cls.members) {
        if (m.kind !== 'method') continue;
        const mm = MAPPING.exec(m.annos);
        if (!mm) continue;
        const args = annoArgs(m.annos, mm[1] + 'Mapping') || '';
        let method = mm[1].toUpperCase();
        if (method === 'REQUEST') method = (/RequestMethod\.(\w+)/.exec(args) || [, 'GET'])[1];
        const sub = literals(args)[0] || '';
        idx.endpoints.push({ method, path: joinPath(base, sub), file: rel, line: m.line, annoLine: m.annoLine, handler: name + '.' + m.name, member: m, controller: cls, params: splitParams(m.params || '') });
      }
    }
    for (const m of cls.members) {
      const q = annoArgs(m.annos, 'Query');
      if (q == null) continue;
      if (/nativeQuery\s*=\s*true/.test(q)) continue;
      const text = literals(q.replace(/(value|name)\s*=\s*/, '')).join('');
      if (text) idx.queries.push({ text, file: rel, line: m.annoLine, method: m.name, repo: name });
    }
  }
  return idx;
}

/** Parámetros de un método o componentes de un record: anotaciones, tipo y nombre. */
function splitParams(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const c of s) {
    if (c === '<' || c === '(') depth++;
    if (c === '>' || c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((text) => {
    const clean = text.trim();
    const annos = (clean.match(/@\w+(?:\s*\((?:[^()"]|"(?:[^"\\]|\\.)*")*\))?/g) || []).join(' ');
    const rest = clean.replace(/@\w+(?:\s*\((?:[^()"]|"(?:[^"\\]|\\.)*")*\))?/g, '').replace(/\bfinal\b/, '').trim();
    const m = /^([\w.<>,?\[\]\s]+?)\s+(\w+)$/.exec(rest);
    return { text: clean, annos, type: m ? m[1].replace(/\s+/g, '') : rest, name: m ? m[2] : rest };
  }).filter((p) => p.name);
}

const simpleTypes = (type) => (type.match(/\b[A-Z]\w*/g) || []);

/** El método del servicio al que delega un handler del controller (para señalar dónde está el arreglo). */
function delegate(idx, endpoint) {
  const m = endpoint.member;
  if (!m || !m.body) return null;
  for (const call of m.body.matchAll(/\b(\w+)\.(\w+)\s*\(/g)) {
    const field = endpoint.controller.fields.find((f) => f.name === call[1]);
    const cls = field && idx.classes.get(simpleTypes(field.type)[0]);
    const target = cls && cls.members.find((x) => x.kind === 'method' && x.name === call[2]);
    if (target) return { cls, method: target, file: cls.rel, line: target.line };
  }
  return null;
}

/** Comprueba un camino JPQL «alias.a.b» contra los campos de las entities. Devuelve el primer atributo que no existe. */
function checkJpql(idx, q) {
  const aliases = new Map();
  const text = q.text;
  for (const m of text.matchAll(/\bFROM\s+(\w+)\s+(?:AS\s+)?(\w+)/gi)) if (idx.entities.has(m[1])) aliases.set(m[2], m[1]);
  for (const m of text.matchAll(/,\s*(\w+)\s+(?:AS\s+)?(\w+)/gi)) if (idx.entities.has(m[1])) aliases.set(m[2], m[1]);
  // JOIN alias.relacion otro: el nuevo alias toma el tipo de la relación.
  for (const m of text.matchAll(/\bJOIN\s+(?:FETCH\s+)?(\w+)\.(\w+)\s+(?:AS\s+)?(\w+)/gi)) {
    const ent = idx.entities.get(aliases.get(m[1]));
    const f = ent && ent.fields.find((x) => x.name === m[2]);
    const target = f && simpleTypes(f.type).find((n) => idx.entities.has(n));
    if (target) aliases.set(m[3], target);
  }
  if (!aliases.size) return [];
  const problems = [];
  const noStrings = text.replace(/'[^']*'/g, "''");
  for (const m of noStrings.matchAll(/(?<![:\w.])(\w+)((?:\.\w+)+)/g)) {
    if (!aliases.has(m[1])) continue;
    let ent = idx.entities.get(aliases.get(m[1]));
    for (const attr of m[2].slice(1).split('.')) {
      if (!ent) break;
      const f = ent.fields.find((x) => x.name === attr);
      if (!f) { problems.push({ path: m[0], attr, entity: ent.name, fields: ent.fields.filter((x) => !/\bstatic\b/.test(x.type)).map((x) => x.name) }); break; }
      ent = idx.entities.get(simpleTypes(f.type).find((n) => idx.entities.has(n)));
    }
  }
  return problems;
}

const hasConstraints = (cls) => cls && cls.fields.some((f) => /@(NotNull|NotBlank|NotEmpty|Size|Min|Max|Positive\w*|Negative\w*|Email|Pattern|Future\w*|Past\w*|Valid|Digits|Decimal\w+)\b/.test(f.annos || ''));

/**
 * Reglas estáticas de Spring que compilan pero fallan (o fallarán) en ejecución.
 * @param F constructor de hallazgos de detectors.js (se pasa para evitar la dependencia circular)
 */
function springFindings(root, F, idx = indexSpring(root)) {
  const out = [];
  for (const cls of idx.classes.values()) {
    for (const m of cls.members) {
      // #3 · Inyección por campo
      if (m.kind === 'field' && has(m.annos, 'Autowired')) {
        out.push(F('maintainability', 'spring-field-injection', 'risk', cls.rel, m.annoLine, cls.name + '.' + m.name, {
          confidence: 95, title: t`Dependencia inyectada con @Autowired en un campo`,
          why: t`Spring rellena «${m.name}» después de crear el objeto. El campo no puede ser final, la dependencia no se ve en el constructor y en una prueba unitaria se queda en null sin avisar.`,
          action: t`Declarar el campo como private final y recibirlo por el constructor (sin @Autowired).`,
          tech: t`@Autowired sobre el campo ${m.type} ${m.name} en ${cls.name}`, evidence: [t`${cls.rel}:${m.annoLine} @Autowired en un campo`],
        }));
      }
      // #2 · @ManyToOne / @OneToOne sin LAZY
      if (m.kind === 'field' && has(cls.annos, 'Entity')) {
        const rel = /@(ManyToOne|OneToOne)\b/.exec(m.annos);
        if (rel && !/FetchType\.LAZY/.test(annoArgs(m.annos, rel[1]) || '')) {
          out.push(F('performance', 'spring-eager-to-one', 'risk', cls.rel, lineOf(cls, m.annoLine, '@' + rel[1]), cls.name + '.' + m.name, {
            confidence: 90, title: t`La relación @${rel[1]} «${m.name}» se carga siempre (EAGER)`,
            why: t`Por defecto @${rel[1]} es EAGER: cada vez que lees un ${cls.name}, Hibernate trae también «${m.name}», aunque no lo uses. Con listas grandes eso multiplica las consultas (problema N+1).`,
            action: t`Usar @${rel[1]}(fetch = FetchType.LAZY) y cargar la relación solo cuando haga falta (JOIN FETCH o DTO).`,
            tech: t`@${rel[1]} sin fetch = FetchType.LAZY`, evidence: [t`${cls.rel}:${m.line} ${m.type} ${m.name}`],
          }));
        }
      }
      // #4 (estático) · Optional.get() sobre findById
      if (m.kind === 'method' && m.body) {
        const lines = m.body.split('\n');
        lines.forEach((l, i) => {
          if (/\.findById\s*\([^)]*\)\s*\.get\s*\(\s*\)/.test(l)) {
            const line = m.line + lineOffset(cls, m, i);
            out.push(F('correctness', 'spring-optional-get', 'risk', cls.rel, line, cls.name + '.' + m.name, {
              confidence: 90, title: t`findById(...).get() falla con 500 si el registro no existe`,
              why: t`Si el id no existe, Optional.get() lanza NoSuchElementException. Nadie la convierte en 404, así que el cliente recibe un 500 «error interno».`,
              action: t`Usar .orElseThrow(() -> new ResourceNotFoundException(...)) para responder 404.`,
              tech: t`Optional.get() en ${cls.name}.${m.name}`, evidence: [l.trim()],
            }));
          }
        });
      }
    }
  }
  for (const ep of idx.endpoints) {
    const m = ep.member;
    // #6 · El controller devuelve una Entity
    const entity = simpleTypes(m.type).find((n) => idx.entities.has(n));
    if (entity) {
      out.push(F('architecture', 'spring-entity-response', 'risk', ep.file, m.line, ep.handler, {
        confidence: 92, title: t`${ep.method} ${ep.path} devuelve la Entity ${entity} en vez de un DTO`,
        why: t`Jackson convierte la Entity a JSON fuera de la transacción: las relaciones LAZY lanzan LazyInitializationException (500) y las bidireccionales pueden entrar en recursión infinita. Además expones la estructura de tu base de datos.`,
        action: t`Devolver un DTO (por ejemplo ${entity.replace(/Entity$/, '')}ResponseDTO) creado dentro del Service.`,
        tech: t`Tipo de retorno ${m.type} en ${ep.handler}`, evidence: [t`${entity} está anotada con @Entity (${idx.entities.get(entity).rel})`],
        related: [{ file: idx.entities.get(entity).rel, line: idx.entities.get(entity).line }],
      }));
    }
    // #5 (estático) · @RequestBody sin @Valid con un DTO que tiene restricciones
    for (const p of ep.params) {
      if (!has(p.annos, 'RequestBody') || has(p.annos, 'Valid') || has(p.annos, 'Validated')) continue;
      const dto = idx.classes.get(simpleTypes(p.type)[0]);
      if (!hasConstraints(dto)) continue;
      out.push(F('correctness', 'spring-missing-valid', 'fail', ep.file, m.line, ep.handler, {
        confidence: 93, title: t`${ep.method} ${ep.path} no valida el cuerpo: falta @Valid`,
        why: t`${dto.name} tiene anotaciones como @NotBlank, pero Spring solo las comprueba si el parámetro lleva @Valid. Sin él se aceptan datos vacíos o incorrectos.`,
        action: t`Escribir @Valid @RequestBody ${p.type} ${p.name}.`,
        tech: t`@RequestBody sin @Valid en ${ep.handler}`, evidence: [t`${dto.rel} declara restricciones de validación`],
        related: [{ file: dto.rel, line: dto.line }],
      }));
    }
    // #9 · Tamaño de página por defecto (informativo)
    for (const p of ep.params) {
      const pd = annoArgs(p.annos, 'PageableDefault');
      if (pd == null) continue;
      const size = (/(?:size|value)\s*=\s*(\d+)/.exec(pd) || /^\s*(\d+)\s*$/.exec(pd) || [, '10'])[1];
      out.push(F('requirements', 'spring-pageable-default', 'human', ep.file, m.line, ep.handler, {
        confidence: 100, title: t`${ep.path} devuelve ${size} elementos por página si no se indica otra cosa`,
        why: t`@PageableDefault fija el tamaño de página y el orden cuando el cliente no manda ?size ni ?sort. Spectator no sabe cuántos pide tu enunciado: compruébalo tú.`,
        action: t`Confirmar que size = ${size} y el orden son los que pide el enunciado.`,
        tech: '@PageableDefault(' + pd.trim() + ')', evidence: [t`${ep.file}:${m.line}`],
      }));
    }
  }
  // #1 · JPQL con atributos que no existen
  for (const q of idx.queries) {
    for (const p of checkJpql(idx, q)) {
      const near = closest(p.attr, p.fields);
      out.push(F('correctness', 'spring-jpql-attribute', 'fail', q.file, q.line, q.method + ':' + p.path, {
        confidence: 96, title: t`La consulta @Query usa «${p.path}», pero ${p.entity} no tiene el atributo «${p.attr}»`,
        why: t`JPQL trabaja con los atributos Java de las Entity, no con columnas. Spring valida esta consulta al arrancar y la aplicación no llega a iniciarse (UnknownPathException).`,
        action: near ? t`Cambiar «${p.attr}» por «${near}».` : t`Usar uno de los atributos de ${p.entity}: ${p.fields.join(', ')}.`,
        tech: t`${q.repo}.${q.method}: ${q.text}`, evidence: [t`Atributos de ${p.entity}: ${p.fields.join(', ')}`],
        related: idx.entities.get(p.entity) ? [{ file: idx.entities.get(p.entity).rel, line: idx.entities.get(p.entity).line }] : [],
      }));
    }
  }
  return out;
}

function lineOf(cls, from, needle) {
  const lines = cls.raw.split('\n');
  for (let i = from - 1; i < Math.min(lines.length, from + 6); i++) if (lines[i] && lines[i].includes(needle)) return i + 1;
  return from;
}
// Línea real de la línea i del cuerpo de un método: se busca el texto en el archivo a partir de la firma.
function lineOffset(cls, m, i) {
  const target = m.body.split('\n')[i].trim();
  const lines = cls.raw.split('\n');
  for (let k = m.line - 1; k < lines.length; k++) if (lines[k].trim() === target || (target && lines[k].includes(target.slice(0, 40)))) return k + 1 - m.line;
  return i;
}
function closest(word, options) {
  const lw = word.toLowerCase();
  return options.find((o) => lw.includes(o.toLowerCase()) || o.toLowerCase().includes(lw)) || null;
}

module.exports = { isSpringProject, indexSpring, springFindings, delegate, checkJpql, closest, simpleTypes, hasConstraints, splitParams };
