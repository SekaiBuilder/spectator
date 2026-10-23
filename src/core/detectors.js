'use strict';
// Detectores deterministas. Cada hallazgo lleva: qué pasa, por qué importa, evidencia y acción.
// severity: fail = demostrado · risk = medible pero requiere criterio · human = solo una persona puede decidir.
const fs = require('fs');
const nodePath = require('path');
const path = nodePath.posix;
const { globToRegex, readJson, hash } = require('./util');
const { findCycles, reachableFromTests } = require('./graph');
const { t, tr } = require('./i18n');

function F(category, rule, severity, file, line, key, o) {
  return { category, rule, severity, file, line: line || 1, key: String(key ?? ''), confidence: 90, deterministic: true, source: 'spectator', evidence: [], ...o };
}

const LOCAL = {
  'unreachable': (l) => ({ severity: 'fail', confidence: 97, title: t`Hay código que nunca se ejecuta`, why: t`Está escrito después de una instrucción que siempre sale de la función, así que no hace nada. Suele indicar un error de lógica.`, action: t`Eliminar ese código o mover la salida anterior.`, tech: t`Código inalcanzable tras «${l.after}»`, evidence: [t`Análisis del árbol sintáctico: sentencia posterior a return/throw/break en el mismo bloque`] }),
  'empty-catch': () => ({ severity: 'risk', confidence: 95, title: t`Un error se ignora en silencio`, why: t`Si algo falla aquí, nadie se entera: el programa sigue como si nada y el problema aparece más tarde en otro sitio.`, action: t`Registrar el error o manejarlo explícitamente.`, tech: t`Bloque catch/except vacío`, evidence: [t`Bloque de captura sin ninguna instrucción`] }),
  'self-compare': (l) => ({ severity: l.nanIdiom ? 'risk' : 'fail', confidence: l.nanIdiom ? 70 : 95, title: t`Se compara un valor consigo mismo`, why: t`La comparación da siempre el mismo resultado, así que la condición no decide nada. Casi siempre es un error al escribir` + (l.nanIdiom ? t` (aunque a veces se usa a propósito para detectar valores no numéricos).` : t`.`), action: t`Revisar con qué se quería comparar realmente.`, tech: t`Ambos lados de la comparación son «${l.symbol}»`, evidence: [t`Los dos operandos son textualmente idénticos`] }),
  'duplicate-key': (l) => ({ severity: 'fail', confidence: 97, title: t`El dato «${l.symbol}» está definido dos veces`, why: t`Solo cuenta el último valor; el primero se pierde sin avisar.`, action: t`Dejar una sola definición.`, tech: t`Clave duplicada «${l.symbol}» en un literal de objeto`, evidence: [t`La misma clave aparece más de una vez en el mismo objeto`] }),
  'mutable-default': () => ({ severity: 'risk', confidence: 92, title: t`Un valor por defecto se comparte entre llamadas`, why: t`La lista o diccionario por defecto se reutiliza: los datos de una llamada aparecen en la siguiente.`, action: t`Usar None por defecto y crear el valor dentro de la función.`, tech: t`Argumento por defecto mutable (Python)`, evidence: [t`Parámetro con valor por defecto [] / {} / set()`] }),
};

function localFindings(irs, textResults, graph) {
  const out = [];
  for (const f of irs) {
    for (const l of f.local) {
      const def = LOCAL[l.rule](l);
      out.push(F('correctness', l.rule, def.severity, f.rel, l.line, l.code, { ...def, code: l.code }));
    }
    if (f.syntaxError) {
      const v8 = f.syntaxError.v8;
      out.push(F('correctness', 'syntax-error', v8 ? 'fail' : 'risk', f.rel, f.syntaxError.line, 'syntax', {
        confidence: v8 ? 100 : 75, title: t`Este archivo tiene un error de escritura y puede no funcionar`,
        why: t`El analizador no pudo entender una parte del archivo. Normalmente significa que el programa fallará al cargarlo.`,
        action: t`Abrir el archivo en la línea indicada y corregir la sintaxis.`, tech: v8 ? 'SyntaxError: ' + v8 : t`tree-sitter produjo un nodo ERROR (puede ser sintaxis muy reciente)`,
        evidence: v8 ? [t`El motor de JavaScript (V8) rechaza el archivo: ` + v8, t`tree-sitter tampoco pudo interpretar la línea ${f.syntaxError.line}`] : [t`El parser de ${f.lang} no pudo interpretar la línea ${f.syntaxError.line}`, t`No confirmado por un segundo analizador`],
      }));
    }
    const txt = textResults.get(f.rel);
    if (!txt) continue;
    // En pruebas, documentación o ejemplos suele ser una clave de mentira escrita a propósito: se avisa como riesgo,
    // no como fallo demostrado, para que no tape las credenciales reales del código.
    const sample = f.isTest || /\.(md|mdx|rst|txt)$/i.test(f.rel) || /(^|\/)(docs?|examples?|demo|fixtures?|samples?)\//i.test(f.rel);
    for (const s of txt.secrets) {
      out.push(F('security', 'secret:' + s.rule, sample ? 'risk' : 'fail', f.rel, s.line, s.rule + ':' + s.preview, {
        confidence: sample ? Math.min(s.confidence, 60) : s.confidence, title: t`Hay una credencial escrita en el código: ${tr(s.name)}`,
        why: sample ? t`Está en un archivo de pruebas, documentación o ejemplo: puede ser una clave de mentira. Si es real, cualquiera con acceso al código puede usarla.`
          : t`Cualquiera con acceso al código (o a su historial) puede usarla. Si el repositorio se comparte, la credencial queda expuesta.`,
        action: t`Mover el valor a una variable de entorno y cambiar (rotar) la credencial.`, tech: t`Regla ${s.rule} · valor ${s.preview}`,
        evidence: [t`Coincide con el patrón «${s.rule}»`, t`El valor se muestra oculto a propósito`],
      }));
    }
    for (const s of txt.security) {
      const d = s.def;
      out.push(F('security', d.id, f.isTest && d.sev === 'fail' ? 'risk' : d.sev, f.rel, s.line, s.code, {
        confidence: 80, title: tr(d.title), why: tr(d.why), action: tr(d.action), tech: t`${d.cwe} · regla ${d.id}`, code: s.code,
        evidence: [t`Patrón «${d.id}» encontrado en la línea`, d.cwe],
      }));
    }
  }
  for (const m of graph.missing) {
    if (m.name) {
      out.push(F('correctness', 'broken-import', 'fail', m.file, m.line, m.spec + '#' + m.name, {
        symbol: m.local, confidence: 96, title: t`Se usa «${m.name}», que no existe en ${m.dest}`,
        why: t`Este archivo pide una pieza a otro archivo del proyecto, pero ese archivo no la ofrece. Al llegar aquí el programa fallará o recibirá un valor vacío.`,
        action: t`Corregir el nombre, o crear y exportar «${m.name}» en el archivo de destino.`, tech: t`import { ${m.name} } from '${m.spec}' · ${m.dest} no lo exporta`,
        evidence: [t`${m.dest} no exporta «${m.name}»`, t`El nombre no aparece en ninguna parte de ese archivo`, t`El destino no usa export * ni CommonJS`], related: [{ file: m.dest, line: 1 }],
      }));
      continue;
    }
    out.push(F('correctness', 'missing-import', 'fail', m.file, m.line, m.spec, {
      confidence: 97, title: t`Se usa un archivo que no existe: ${m.spec}`,
      why: t`El programa fallará al arrancar o al llegar a esta parte, porque intenta cargar algo que no está en el proyecto.`,
      action: t`Crear el archivo que falta o corregir la ruta.`, tech: t`Import relativo sin resolver: ${m.spec}`,
      evidence: [t`La ruta no existe en disco con ninguna extensión conocida`],
    }));
  }
  return out;
}

function maintainability(irs, cfg) {
  const out = [];
  const L = cfg.limits;
  for (const f of irs) {
    if (f.isTest) continue;
    if (f.lines > L.fileLines) {
      out.push(F('maintainability', 'large-file', 'risk', f.rel, 1, 'large-file', {
        title: t`Este archivo es demasiado grande`, why: t`Cuanto más grande es un archivo, más difícil es entenderlo y más fácil romper algo al cambiarlo.`,
        action: t`Dividirlo en partes con una responsabilidad clara.`, tech: t`${f.lines} líneas (límite ${L.fileLines}) · ${f.units.length} funciones`,
        evidence: [t`${f.lines} líneas contadas`, t`Límite configurado: ${L.fileLines}`],
      }));
    }
    for (const u of f.units) {
      const len = u.endLine - u.line + 1;
      const issues = [];
      if (u.cx >= L.complexity) issues.push(t`complejidad ${u.cx} (límite ${L.complexity})`);
      if (len > L.functionLines) issues.push(t`${len} líneas (límite ${L.functionLines})`);
      if (u.params > L.params) issues.push(t`${u.params} parámetros (límite ${L.params})`);
      if (u.maxNest > L.nesting) issues.push(t`${u.maxNest} niveles de anidación (límite ${L.nesting})`);
      if (!issues.length) continue;
      out.push(F('maintainability', 'complex-function', u.cx >= L.complexityFail ? 'fail' : 'risk', f.rel, u.line, u.id, {
        symbol: u.name, confidence: 100, title: t`La función «${u.name}» es difícil de entender`,
        why: t`Tiene demasiados caminos posibles. Es donde más fácil se esconden errores y donde más cuesta hacer cambios seguros.`,
        action: t`Separarla en funciones más pequeñas, cada una con una sola tarea.`, tech: issues.join(' · '),
        evidence: issues.map((i) => t`Medido: ` + i),
      }));
    }
  }
  return out;
}

const ENTRY_NAMES = /^(main|constructor|__\w+__|init|setup|teardown|activate|deactivate|render|handler|default|run|configure|register|up|down|toString|toJSON|equals|hashCode|dispose|componentDid\w+|ngOn\w+|get[A-Z]\w*Props|loader|action|middleware|test\w*|Test\w*)$/;

function deadCode(irs, graph, cfg) {
  const counts = new Map();
  for (const f of irs) for (const [k, v] of f.idents) counts.set(k, (counts.get(k) || 0) + v);
  const imported = new Set();
  for (const set of graph.fileEdges.values()) for (const dst of set) imported.add(dst);
  const out = [];
  for (const f of irs) {
    if (f.isTest || !f.parsed) continue;
    const isEntry = !imported.has(f.rel) || /(^|\/)(index|main|__init__|app|server|cli|mod|lib)\.[a-z]+$/.test(f.rel);
    for (const u of f.units) {
      if (u.decorated || ENTRY_NAMES.test(u.name) || u.name.length < 3) continue;
      const same = graph.unitsByName.get(u.name) || [];
      const defs = same.length;
      if ((counts.get(u.name) || 0) > defs + same.reduce((n, x) => n + (x.exportRefs || 0), 0)) continue;
      if (u.exported && (isEntry || u.cls)) continue;
      out.push(F('maintainability', u.exported ? 'unused-export' : 'unused-function', 'risk', f.rel, u.line, u.id, {
        symbol: u.name, confidence: u.exported ? 60 : 85, title: t`Nadie usa la función «${u.name}»`,
        why: t`Código que no se usa confunde, hay que mantenerlo igual y puede esconder errores. A veces indica que algo quedó a medias.`,
        action: t`Confirmar que no se usa desde fuera del proyecto y eliminarla, o conectarla donde debía usarse.`,
        tech: t`El identificador «${u.name}» solo aparece en su propia definición` + (u.exported ? t` (está exportado: podría usarse desde fuera)` : ''),
        evidence: [t`${counts.get(u.name) || 0} aparición(es) del nombre en todo el proyecto, ${defs} definición(es)`],
      }));
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, 80);
}

function duplication(irs, cfg, interner) {
  const W = cfg.limits.duplicateTokens;
  const minLines = cfg.limits.duplicateLines;
  const seen = new Map(); // clave de ventana -> [archivo, posición]
  const clones = [];
  const files = irs.filter((f) => f.tokens && !f.isTest && f.tokens.length >= W);
  let p1 = 1, p2 = 1;
  for (let i = 0; i < W - 1; i++) { p1 = Math.imul(p1, 31); p2 = Math.imul(p2, 1000003); }
  for (let fi = 0; fi < files.length; fi++) {
    const tk = files[fi].tokens, lines = files[fi].tokenLines, n = tk.length;
    const keys = new Float64Array(n - W + 1);
    let h1 = 0, h2 = 0;
    for (let i = 0; i < W; i++) { h1 = (Math.imul(h1, 31) + tk[i]) | 0; h2 = (Math.imul(h2, 1000003) + tk[i]) | 0; }
    keys[0] = (h1 >>> 0) * 2097152 + (h2 >>> 11);
    for (let i = 1; i <= n - W; i++) {
      h1 = (Math.imul(h1 - Math.imul(tk[i - 1], p1), 31) + tk[i + W - 1]) | 0;
      h2 = (Math.imul(h2 - Math.imul(tk[i - 1], p2), 1000003) + tk[i + W - 1]) | 0;
      keys[i] = (h1 >>> 0) * 2097152 + (h2 >>> 11);
    }
    for (let i = 0; i <= n - W; i++) {
      // Solo se indexan y consultan inicios de línea: 8x menos memoria y los clones reales empiezan en línea.
      if (i > 0 && lines[i] === lines[i - 1]) continue;
      const hit = seen.get(keys[i]);
      if (!hit) { seen.set(keys[i], [fi, i]); continue; }
      const [gi, gp] = hit;
      const g = files[gi].tokens;
      if (gi === fi && i - gp < W) continue;
      let len = 0;
      while (i + len < n && gp + len < g.length && tk[i + len] === g[gp + len] && !(gi === fi && gp + len >= i)) len++;
      if (len < W) continue;
      const bStart = lines[i], bEnd = lines[i + len - 1];
      const aStart = files[gi].tokenLines[gp], aEnd = files[gi].tokenLines[gp + len - 1];
      if (bEnd - bStart + 1 >= minLines) {
        const key = hash(JSON.stringify(Array.from(tk.subarray(i, i + W), (id) => interner.values[id])));
        clones.push({ a: { file: files[gi].rel, line: aStart, end: aEnd }, b: { file: files[fi].rel, line: bStart, end: bEnd }, tokens: len, key });
      }
      i += len - 1;
    }
  }
  clones.sort((x, y) => y.tokens - x.tokens);
  return clones.slice(0, 80).map((c) => {
    const n = c.b.end - c.b.line + 1;
    return F('duplication', 'clone', 'risk', c.b.file, c.b.line, `${c.a.file}:${c.key}`, {
      endLine: c.b.end, confidence: 100, title: t`${n} líneas repetidas en otro lugar`,
      why: t`La misma lógica existe en dos sitios. Si se corrige o cambia en uno y no en el otro, el programa se comporta de forma distinta según por dónde se entre.`,
      action: t`Extraer la parte común a una sola función y usarla en ambos sitios.`,
      tech: t`${c.tokens} tokens idénticos con ${c.a.file}:${c.a.line}-${c.a.end}`,
      evidence: [t`Copia 1: ${c.a.file} líneas ${c.a.line}–${c.a.end}`, t`Copia 2: ${c.b.file} líneas ${c.b.line}–${c.b.end}`, t`Comparación exacta de tokens (ignora espacios, comentarios y valores literales)`],
      related: [{ file: c.a.file, line: c.a.line }],
    });
  });
}

const UI_LAYER = /(^|\/)(controllers?|routes?|handlers?|views?|pages?|components?|api|endpoints?)\//i;
const DATA_LAYER = /(^|\/)(repositor(y|ies)|db|database|dao|models?|entities|persistence)\//i;
const SERVICE_LAYER = /(^|\/)(services?|use-?cases?|domain|business)\//i;

function architecture(irs, graph, cfg) {
  const out = [];
  const prodEdges = new Map();
  for (const [k, v] of graph.importEdges) if (!graph.byRel.get(k).isTest) prodEdges.set(k, v);
  const importOnly = new Map([...graph.importEdges].filter(([k]) => !graph.byRel.get(k).isTest));
  for (const cyc of findCycles(importOnly)) {
    const sorted = [...cyc].sort();
    out.push(F('architecture', 'cycle', 'risk', sorted[0], 1, sorted.join('|'), {
      confidence: 100, title: t`${cyc.length} archivos dependen unos de otros en círculo`,
      why: t`El ciclo está demostrado; que falle al ejecutarse, no. Según el orden de carga puede causar errores al arrancar, y un cambio pequeño puede afectar a todo el grupo.`,
      action: t`Mover lo que comparten a un archivo aparte del que dependan todos.`,
      tech: t`Ciclo de imports: ` + cyc.slice(0, 8).join(' → ') + (cyc.length > 8 ? ' …' : ''),
      evidence: cyc.slice(0, 8).map((c) => t`En el ciclo: ` + c), related: sorted.slice(1, 8).map((file) => ({ file, line: 1 })),
    }));
  }
  const rules = (cfg.architecture || []).filter((r) => r.from && r.deny).map((r) => ({ ...r, fromRe: globToRegex(r.from), denyRe: globToRegex(r.deny) }));
  const hasServices = irs.some((f) => SERVICE_LAYER.test(f.rel));
  for (const [from, tos] of prodEdges) {
    for (const to of tos) {
      for (const r of rules) {
        if (r.fromRe.test(from) && r.denyRe.test(to)) {
          out.push(F('architecture', 'rule:' + (r.name || r.from), 'fail', from, 1, to, {
            confidence: 100, title: t`Se rompe una regla de arquitectura: ${r.name || t`${r.from} no debe usar ${r.deny}`}`,
            why: r.message || t`El proyecto definió que estas dos partes no deben conectarse directamente.`,
            action: t`Pasar por la capa intermedia prevista.`, tech: t`${from} importa ${to}`,
            evidence: [t`Regla en spectator.json: ${r.from} ✕ ${r.deny}`, t`Import real: ${from} → ${to}`], related: [{ file: to, line: 1 }],
          }));
        }
      }
      if (hasServices && UI_LAYER.test(from) && DATA_LAYER.test(to) && !DATA_LAYER.test(from) && !/(^|\/)models?\//i.test(to)) {
        out.push(F('architecture', 'layer-skip', 'human', from, 1, to, {
          confidence: 70, deterministic: true, title: t`Una pantalla o ruta accede a los datos saltándose la capa intermedia`,
          why: t`El proyecto tiene una capa de servicios, pero aquí se va directo a los datos. Puede ser intencional; si no lo es, las reglas del negocio no se aplican en este camino.`,
          action: t`Decidir: ¿es intencional? Si no, pasar por el servicio correspondiente.`, tech: t`${from} → ${to} (esperado: controlador → servicio → datos)`,
          evidence: [t`Import directo: ${from} → ${to}`, t`El proyecto contiene una carpeta de servicios`], related: [{ file: to, line: 1 }],
        }));
      }
    }
  }
  return out;
}

function dependencies(root, files, irs, graph) {
  const out = [];
  const pkgFiles = files.filter((f) => path.basename(f.rel) === 'package.json');
  const pkgs = new Map(); // dir -> json
  for (const p of pkgFiles) { const j = readJson(p.abs); if (j) pkgs.set(path.dirname(p.rel), j); }
  const workspaceNames = new Set([...pkgs.values()].map((j) => j.name).filter(Boolean));
  const tsPaths = Object.keys(readJson(nodePath.join(root, 'tsconfig.json'), {})?.compilerOptions?.paths || {}).map((k) => k.replace(/\/?\*$/, ''));
  const declaredFor = (dir) => {
    const all = new Set(); let has = false;
    for (let d = dir; ; d = path.dirname(d)) {
      const j = pkgs.get(d);
      if (j) { has = true; for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) for (const n of Object.keys(j[k] || {})) all.add(n); if (j.engines?.vscode) all.add('vscode'); }
      if (d === '.' || d === '/') break;
    }
    return has ? all : null;
  };
  const usedByPkgDir = new Map();
  const reported = new Set();
  for (const f of irs) {
    const used = graph.packages.get(f.rel);
    if (!used || !used.size) continue;
    const dir = path.dirname(f.rel);
    const declared = declaredFor(dir);
    for (let d = dir; ; d = path.dirname(d)) {
      if (pkgs.has(d)) { const s = usedByPkgDir.get(d) || usedByPkgDir.set(d, new Set()).get(d); for (const u of used) s.add(u); }
      if (d === '.' || d === '/') break;
    }
    if (!declared) continue;
    for (const name of used) {
      if (declared.has(name) || workspaceNames.has(name) || tsPaths.some((p) => p && (name === p || name.startsWith(p + '/') || p.startsWith(name))) || /^(bun|deno|electron)$/.test(name) || reported.has(name)) continue;
      reported.add(name);
      const line = (f.imports.find((i) => i.spec === name || i.spec.startsWith(name + '/')) || {}).line;
      out.push(F('dependencies', 'undeclared', 'fail', f.rel, line, name, {
        confidence: 92, title: t`Se usa el paquete «${name}» pero no está declarado`,
        why: t`Funciona en tu máquina solo si ya estaba instalado por casualidad. En otra máquina o en producción fallará. También puede ser un paquete que no existe.`,
        action: t`Comprobar que el paquete existe y añadirlo a package.json (npm install ${name}).`, tech: t`Import de «${name}» sin entrada en dependencies/devDependencies`,
        evidence: [t`No aparece en ningún package.json del proyecto`, t`Importado en ${f.rel}`],
      }));
    }
  }
  for (const [dir, j] of pkgs) {
    const rel = dir === '.' ? 'package.json' : dir + '/package.json';
    const all = { ...(j.dependencies || {}), ...(j.devDependencies || {}) };
    for (const [name, ver] of Object.entries(all)) {
      if (typeof ver !== 'string') continue;
      if (ver === '*' || ver === 'latest' || ver === '') {
        out.push(F('dependencies', 'unpinned', 'risk', rel, 1, name, { confidence: 100, title: t`El paquete «${name}» no tiene una versión fija`, why: t`Cada instalación puede traer una versión distinta; algo que hoy funciona puede romperse mañana sin que cambies nada.`, action: t`Fijar un rango de versión concreto.`, tech: t`"${name}": "${ver}"`, evidence: [t`Versión declarada: «${ver}»`] }));
      } else if (/^(git|http|https|github:)/.test(ver)) {
        out.push(F('dependencies', 'url-dependency', 'risk', rel, 1, name, { confidence: 100, title: t`El paquete «${name}» se descarga desde una URL`, why: t`No pasa por el registro oficial: su contenido puede cambiar sin control de versiones ni auditoría.`, action: t`Usar una versión publicada o fijar un commit concreto.`, tech: t`"${name}": "${ver}"`, evidence: [t`Origen: ${ver}`] }));
      }
    }
    const abs = nodePath.join(root, dir);
    const hasDeps = Object.keys(all).length > 0;
    if (dir !== '.' && pkgs.has('.')) continue; // en un monorepo, el bloqueo y el resto de comprobaciones de raíz se informan una vez
    const lock = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'npm-shrinkwrap.json'].some((l) => fs.existsSync(nodePath.join(abs, l)) || fs.existsSync(nodePath.join(root, l)));
    if (hasDeps && !lock) {
      out.push(F('dependencies', 'no-lockfile', 'risk', rel, 1, 'lock', { confidence: 100, title: t`No hay archivo de bloqueo de versiones`, why: t`Sin él, dos instalaciones del mismo proyecto pueden acabar con versiones diferentes de las librerías.`, action: t`Ejecutar la instalación y guardar el archivo de bloqueo en el repositorio.`, tech: t`Falta package-lock.json / yarn.lock / pnpm-lock.yaml`, evidence: [t`No se encontró ningún lockfile`] }));
    }
    const used = usedByPkgDir.get(dir) || new Set();
    const scripts = JSON.stringify(j.scripts || {}) + JSON.stringify(j.bin || '');
    const hasSource = irs.some((f) => f.lang && (dir === '.' || f.rel.startsWith(dir + '/')));
    if (hasSource) {
      for (const name of Object.keys(j.dependencies || {})) {
        if (used.has(name) || name.startsWith('@types/') || scripts.includes(name.split('/').pop())) continue;
        out.push(F('dependencies', 'unused', 'risk', rel, 1, 'unused:' + name, { confidence: 70, title: t`El paquete «${name}» está instalado pero no se usa`, why: t`Cada dependencia añade peso y posibles vulnerabilidades. Si no se usa, sobra.`, action: t`Confirmar que no lo carga una herramienta o configuración y desinstalarlo.`, tech: t`«${name}» en dependencies sin ningún import`, evidence: [t`Ningún archivo analizado lo importa`, t`No aparece en los scripts de package.json`] }));
      }
    }
  }
  const req = nodePath.join(root, 'requirements.txt');
  if (fs.existsSync(req)) {
    const loose = fs.readFileSync(req, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !/^(#|-)/.test(l) && !/==|@/.test(l));
    if (loose.length) out.push(F('dependencies', 'unpinned-python', 'risk', 'requirements.txt', 1, 'unpinned', { confidence: 100, title: t`${loose.length} librería(s) de Python sin versión fija`, why: t`Cada instalación puede traer versiones distintas y romper algo sin que cambies el código.`, action: t`Fijar las versiones con ==.`, tech: loose.slice(0, 8).join(', '), evidence: loose.slice(0, 8).map((l) => t`Sin fijar: ` + l) }));
  }
  return out;
}

const IMPLICIT_IMPORTS = new Set(['swift', 'kotlin', 'java', 'c_sharp', 'go']);

function testing(irs, graph, cfg) {
  const out = [];
  const src = irs.filter((f) => f.lang && !f.isTest && f.units.length);
  const tests = irs.filter((f) => f.lang && f.isTest);
  // En JS/TS y Python un test alcanza el código por sus imports. Swift, Kotlin, Java, C# y Go no importan
  // archivos de su propio módulo, así que ahí se sigue el uso de tipos y las llamadas resueltas.
  const testEdges = new Map();
  for (const f of irs) testEdges.set(f.rel, (IMPLICIT_IMPORTS.has(f.lang) ? graph.fileEdges : graph.importEdges).get(f.rel) || new Set());
  const { direct, reachable } = reachableFromTests(irs, testEdges);
  const stats = { testFiles: tests.length, sourceFiles: src.length, covered: src.filter((f) => reachable.has(f.rel)).length };
  if (!tests.length) {
    if (src.length >= 2) {
      out.push(F('testing', 'no-tests', 'fail', src[0].rel, 1, 'no-tests', {
        scope: 'project', confidence: 100, title: t`El proyecto no tiene ninguna prueba automática`,
        why: t`Nada comprueba que el programa hace lo que debe. Cada cambio puede romper algo sin que nadie lo note hasta que falle en uso real.`,
        action: t`Empezar por probar las funciones más complejas o críticas.`, tech: t`0 archivos de test para ${src.length} archivos de código`,
        evidence: [t`No se encontró ningún archivo test/spec`, t`${src.length} archivos con funciones`],
      }));
    }
    return { findings: out, stats, direct, reachable };
  }
  for (const tf of tests) {
    // Preparación, mocks y ayudantes viven junto a las pruebas pero no son pruebas: no se espera que comprueben nada.
    if (/(^|[\/._-])(setup|teardown|mocks?|fixtures?|helpers?|utils?|factory|factories|conftest|preset|config)([._-]|\.\w+$)/i.test(tf.rel.split('/').pop())) continue;
    // También cuando viven en su propia carpeta: tests/utils/user.py, e2e/helpers/login.ts.
    if (tf.rel.split('/').slice(0, -1).some((d) => /^(__mocks__|mocks?|fixtures?|helpers?|utils?|support|factories)$/i.test(d))) continue;
    if (tf.parsed && !tf.hasAssert && tf.units.length + tf.moduleUnit.calls.size > 0) {
      out.push(F('testing', 'no-assert', 'fail', tf.rel, 1, 'no-assert', {
        confidence: 85, title: t`Esta prueba no comprueba nada`,
        why: t`Ejecuta código pero nunca verifica el resultado, así que siempre «pasa» aunque el programa esté mal. Da una falsa sensación de seguridad.`,
        action: t`Añadir comprobaciones (assert/expect) del resultado esperado.`, tech: t`Archivo de test sin ninguna aserción`,
        evidence: [t`No aparece ningún assert / expect / should / verify en el archivo`],
      }));
    }
  }
  const threshold = Math.max(6, Math.floor(cfg.limits.complexity / 2));
  const risky = src.filter((f) => !reachable.has(f.rel)).map((f) => ({ f, top: f.units.reduce((a, u) => (u.cx > a.cx ? u : a), f.units[0]) }))
    .filter((x) => x.top.cx >= threshold).sort((a, b) => b.top.cx - a.top.cx).slice(0, 30);
  for (const { f, top } of risky) {
    out.push(F('testing', 'untested-complex', 'risk', f.rel, top.line, 'untested', {
      symbol: top.name, confidence: 85, title: t`Lógica compleja sin ninguna prueba`,
      why: t`Este archivo toma muchas decisiones y ninguna prueba llega hasta él. Es el lugar más probable para un error que nadie detecta.`,
      action: t`Escribir pruebas empezando por «${top.name}».`, tech: t`Ningún test importa este archivo (directa o indirectamente) · complejidad máxima ${top.cx} en ${top.name}()`,
      evidence: [t`Recorrido del grafo de imports desde todos los tests: no se alcanza`, t`Función más compleja: ${top.name} (${top.cx})`],
    }));
  }
  return { findings: out, stats, direct, reachable };
}

function performance(irs) {
  const out = [];
  for (const f of irs) {
    if (f.isTest) continue;
    for (const u of f.units) {
      const fl = u.flags || {};
      if (fl.queryInLoop) {
        out.push(F('performance', 'query-in-loop', 'risk', f.rel, fl.queryInLoop.line, u.id + ':q', { symbol: u.name, confidence: 65, title: t`Se consulta un servicio o base de datos dentro de un bucle`, why: t`Con 10 elementos son 10 consultas; con 10.000 son 10.000. Funciona en pruebas y se vuelve muy lento con datos reales.`, action: t`Pedir todos los datos en una sola consulta antes del bucle.`, tech: t`Llamada a ${fl.queryInLoop.name}() dentro de un bucle en ${u.name}() (posible N+1)`, evidence: [t`Llamada «${fl.queryInLoop.name}» dentro de un bucle`, t`Es un indicio: depende de qué haga esa llamada`] }));
      }
      if (fl.awaitInLoop) {
        out.push(F('performance', 'await-in-loop', 'risk', f.rel, fl.awaitInLoop, u.id + ':a', { symbol: u.name, confidence: 70, title: t`Se espera una operación tras otra dentro de un bucle`, why: t`Cada vuelta espera a que termine la anterior. Si las operaciones son independientes, se podrían hacer a la vez y tardar mucho menos.`, action: t`Si no dependen entre sí, lanzarlas juntas (Promise.all).`, tech: t`await dentro de un bucle en ${u.name}()`, evidence: [t`Expresión await dentro de un bucle`] }));
      }
      if (fl.nestedLoops) {
        out.push(F('performance', 'nested-loops', 'risk', f.rel, fl.nestedLoops, u.id + ':n', { symbol: u.name, confidence: 75, title: t`Tres o más bucles uno dentro de otro`, why: t`El trabajo crece muy rápido con la cantidad de datos: 100 elementos pueden ser un millón de pasos.`, action: t`Revisar si se puede usar un índice o mapa para evitar un nivel.`, tech: t`Bucles anidados (≥3) en ${u.name}()`, evidence: [t`Tres niveles de bucle anidados en la misma función`] }));
      }
    }
  }
  return out;
}

const RULE_WORD = /(max|min|limit|timeout|ttl|threshold|retr|expir|age|rate|fee|price|tax|discount|quota|attempt|duration|interval|length|size|days|hours|minutes|edad|precio|intentos)/i;
const opEq = (a, b) => String(a).replace('===', '==').replace(/^=$/, '==') === String(b).replace('===', '==').replace(/^=$/, '==');

function statements(irs, cfg) {
  const out = [];
  const all = [];
  const testIdents = irs.filter((f) => f.isTest).map((f) => f.idents);
  for (const f of irs) {
    if (f.isTest) continue;
    for (const s of f.statements) {
      const dir = path.dirname(f.rel).split('/').filter((p) => !/^(\.|src|app|lib|source|main|internal|pkg)$/.test(p)).pop();
      const group = dir || path.basename(f.rel).replace(/\.[^.]+$/, '');
      all.push({ ...s, file: f.rel, group: group.charAt(0).toUpperCase() + group.slice(1), status: 'unconfirmed' });
    }
  }
  const byName = new Map();
  for (const s of all) { const k = s.name.toLowerCase(); (byName.get(k) || byName.set(k, []).get(k)).push(s); }

  // Trazabilidad: quién usa cada constante y cuántos tests la mencionan.
  const constNames = new Set(all.filter((s) => s.kind === 'constante').map((s) => s.name));
  const usersOf = new Map();
  for (const f of irs) {
    if (f.isTest) continue;
    for (const u of f.units) for (const r of u.refs) if (constNames.has(r)) { const l = usersOf.get(r) || usersOf.set(r, []).get(r); if (l.length < 8) l.push(u.name); }
  }
  const testCount = new Map();
  for (const s of all) {
    const base = s.name.split('.')[0];
    if (!testCount.has(base)) testCount.set(base, testIdents.reduce((n, m) => n + (m.has(base) ? 1 : 0), 0));
    s.tests = testCount.get(base);
    if (s.kind === 'constante') s.usedBy = usersOf.get(s.name) || [];
    else s.usedBy = s.unit && s.unit !== '<módulo>' ? [s.unit] : [];
  }

  for (const c of cfg.contract || []) {
    let re = null;
    try { re = c.match ? new RegExp(c.match, 'i') : null; } catch { /* patrón inválido: se trata como no encontrado */ }
    const matches = all.filter((s) => (re ? re.test(s.name) : s.name.toLowerCase() === String(c.name || '').toLowerCase()) && (!c.file || s.file === c.file));
    const label = c.description || c.name || c.match;
    const expected = `${c.operator || '='} ${JSON.stringify(c.value)}`;
    if (!matches.length) {
      out.push(F('requirements', 'contract-missing', 'human', 'spectator.json', 1, 'missing:' + (c.id || label), {
        confidence: 100, title: t`No encuentro en el código la norma «${label}»`,
        why: t`El contrato del proyecto dice que esta norma debe existir, pero ninguna parte del código la aplica (o usa otro nombre).`,
        action: t`Indicar dónde se aplica o implementar la norma.`, tech: t`${c.id || ''} esperado: ${c.name || c.match} ${expected}`.trim(),
        evidence: [t`Norma definida en spectator.json`, t`Ninguna comparación ni constante coincide con ese nombre`],
      }));
      continue;
    }
    for (const s of matches) {
      s.contractId = c.id || label;
      const ok = opEq(s.op, c.operator || '=') && s.value === c.value;
      s.status = ok ? 'ok' : 'conflict';
      s.expected = expected;
      if (!ok) {
        const actual = JSON.stringify(s.value);
        out.push(F('requirements', 'contract-conflict', 'fail', s.file, s.line, 'conflict:' + (c.id || label) + ':' + s.name, {
          symbol: s.name, confidence: 100, title: t`El código no cumple la norma «${label}»`,
          why: t`El proyecto definió ${c.name || s.name} ${expected}, pero el código aplica ${s.name} ${s.op} ${actual}. El programa se comporta distinto a lo acordado.`,
          action: t`Corregir el código o actualizar la norma si la decisión cambió.`, tech: t`${c.id || t`Norma`} · esperado ${expected} · real ${s.op} ${actual}`, code: s.code,
          evidence: [t`Esperado: ${c.name || s.name} ${expected}`, t`Real: ${s.name} ${s.op} ${actual}`, t`Definido en ${s.file}:${s.line}`],
        }));
      }
    }
  }

  for (const [, list] of byName) {
    const variants = new Map();
    for (const s of list) { const k = s.op + ' ' + s.value; (variants.get(k) || variants.set(k, []).get(k)).push(s); }
    const sameKind = new Set(list.map((s) => s.kind)).size === 1;
    if (variants.size < 2 || !sameKind || list.every((s) => s.status === 'ok' || s.status === 'conflict')) continue;
    if (list[0].kind === 'constante' && (list.some((s) => typeof s.value === 'string') || !RULE_WORD.test(list[0].name))) continue;
    if (list[0].kind === 'regla') {
      // Solo es incoherencia si es el mismo tipo de límite, con valores distintos, en funciones distintas.
      // (total > 100 y total > 300 dentro de una misma función son tramos, no una contradicción.)
      const family = (op) => (op[0] === '>' ? 'min' : op[0] === '<' ? 'max' : 'eq');
      const fams = new Set(list.map((s) => family(s.op)));
      const places = new Set(list.map((s) => s.file + '#' + s.unit));
      if (fams.size > 1 || fams.has('eq') || places.size < 2 || new Set(list.map((s) => s.value)).size < 2 || !RULE_WORD.test(list[0].name)) continue;
    }
    for (const s of list) if (s.status === 'unconfirmed') s.status = 'inconsistent';
    const first = list[0];
    out.push(F('requirements', 'inconsistent', 'human', first.file, first.line, 'inconsistent:' + first.name.toLowerCase(), {
      symbol: first.name, confidence: 90, title: t`La norma «${first.name}» tiene valores distintos según el lugar`,
      why: t`El programa aplica reglas diferentes para lo mismo dependiendo de por dónde se entre. Solo tú sabes cuál es el valor correcto.`,
      action: t`Decidir el valor correcto y confirmarlo en Reglas.`, tech: [...variants.keys()].map((v) => `${first.name} ${v}`).join('  ·  '),
      evidence: list.slice(0, 6).map((s) => `${s.name} ${s.op} ${s.value} — ${s.file}:${s.line}`), related: list.slice(1, 6).map((s) => ({ file: s.file, line: s.line })),
    }));
  }
  return { findings: out, statements: all.slice(0, 2000) };
}

function context(root, irs, cfg, stmts) {
  const out = [];
  if (!['README.md', 'README', 'readme.md', 'README.rst', 'README.txt'].some((r) => fs.existsSync(nodePath.join(root, r)))) {
    out.push(F('context', 'no-readme', 'risk', 'README.md', 1, 'no-readme', { scope: 'project', confidence: 100, title: t`El proyecto no explica qué es ni cómo se usa`, why: t`Sin un README, cualquier persona (o herramienta) que llegue al proyecto tiene que adivinar su propósito y cómo arrancarlo.`, action: t`Crear un README con: qué hace, cómo se instala y cómo se ejecuta.`, tech: t`Falta README`, evidence: [t`No existe README en la raíz`] }));
  }
  if (!(cfg.contract || []).length && stmts.length) {
    out.push(F('context', 'no-contract', 'human', 'spectator.json', 1, 'no-contract', { scope: 'project', confidence: 100, title: t`Todavía no has confirmado las normas de tu proyecto`, why: t`Encontré ${stmts.length} valores que gobiernan el comportamiento (límites, edades, tiempos…). No puedo saber si son los que tú quieres: eso solo lo sabes tú.`, action: t`Abrir la pestaña Reglas y confirmar los que sean correctos. A partir de ahí avisaré si alguien los cambia.`, tech: t`spectator.json no tiene sección "contract"`, evidence: [t`${stmts.length} statements detectados sin confirmar`] }));
  }
  let n = 0;
  for (const f of irs) {
    for (const td of f.todos) {
      if (n++ >= 60) break;
      out.push(F('context', 'todo', 'human', f.rel, td.line, td.tag + ':' + td.text, { confidence: 100, title: t`Pendiente anotado en el código: ${td.text || td.tag}`, why: t`Quien escribió esto dejó constancia de que falta algo o de que la solución es provisional.`, action: t`Decidir si se resuelve ahora, se planifica o se descarta.`, tech: t`${td.tag}: ${td.text}`, evidence: [t`Comentario ${td.tag} en la línea ${td.line}`] }));
    }
  }
  return out;
}

module.exports = { F, localFindings, maintainability, deadCode, duplication, architecture, dependencies, testing, performance, statements, context };
