'use strict';
// Grafo universal del proyecto: archivos <-imports-> archivos, funciones <-calls-> funciones.
const fs = require('fs');
const path = require('path').posix;
const nodePath = require('path');
const { resolveCalls } = require('./bindings');

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const NODE_BUILTINS = new Set(require('module').builtinModules);
const COMMON_NAMES = new Set(`get set run init main start stop open close read write send add remove delete update create find
  save load parse render handle process execute call apply test setup next done then catch push pop map filter log error
  toString valueOf constructor index name value data length size`.split(/\s+/));

const noExt = (p) => p.replace(/\.[^./]+$/, '');
const IMPLICIT = new Set(['swift', 'kotlin', 'java', 'c_sharp', 'go']);
const isJsLang = (l) => l === 'javascript' || l === 'typescript' || l === 'tsx';

function buildGraph(root, irs, state = {}) {
  const byRel = new Map(irs.map((f) => [f.rel, f]));
  const previous = state.irs || new Map();
  const changed = new Set([...previous.keys(), ...byRel.keys()].filter((rel) => previous.get(rel) !== byRel.get(rel)));
  const topologyChanged = [...changed].some((rel) => !previous.has(rel) || !byRel.has(rel) || previous.get(rel).lang !== byRel.get(rel).lang);
  const hierarchyChanged = [...changed].some((rel) => previous.get(rel)?.bindings?.classes?.length || byRel.get(rel)?.bindings?.classes?.length);
  const changedSymbols = new Set([...changed].flatMap((rel) => [previous.get(rel), byRel.get(rel)].filter(Boolean).flatMap((f) => f.units.map((u) => f.lang + ':' + u.name))));
  const stats = { updatedFiles: changed.size, importsReused: 0, callsReused: 0, callsResolved: 0, cacheHit: false };
  state.imports ||= new Map();
  state.calls ||= new Map();
  // Los índices de símbolos se actualizan solo para archivos añadidos, modificados o borrados.
  state.indexes ||= { byNoExt: new Map(), byBase: new Map(), dirs: new Map(), unitsByName: new Map(), unitsByFile: new Map(), fileOfUnit: new Map() };
  const { byNoExt, byBase, dirs, unitsByName, unitsByFile, fileOfUnit } = state.indexes;
  const add = (map, key, value) => { (map.get(key) || map.set(key, []).get(key)).push(value); };
  const remove = (map, key, value) => {
    const remaining = (map.get(key) || []).filter((entry) => entry !== value);
    if (remaining.length) map.set(key, remaining); else map.delete(key);
  };
  for (const rel of changed) {
    const old = previous.get(rel);
    if (old) {
      if (old.lang) {
        const ne = noExt(rel);
        remove(byNoExt, ne, rel); if (!byNoExt.has(ne)) remove(byBase, path.basename(ne), ne); remove(dirs, path.dirname(rel), rel);
      }
      for (const unit of old.units) { remove(unitsByName, unit.name, unit); fileOfUnit.delete(unit.id); }
      unitsByFile.delete(rel);
    }
    const f = byRel.get(rel);
    if (!f) { state.imports.delete(rel); state.calls.delete(rel); continue; }
    if (!f.bindings) state.calls.delete(rel);
    const named = new Map();
    for (const unit of f.units) { add(named, unit.name, unit); add(unitsByName, unit.name, unit); fileOfUnit.set(unit.id, rel); }
    unitsByFile.set(rel, named);
    if (!f.lang) { state.imports.delete(rel); state.calls.delete(rel); continue; }
    const ne = noExt(f.rel);
    add(byNoExt, ne, f.rel);
    const base = path.basename(ne);
    if (!(byBase.get(base) || []).includes(ne)) add(byBase, base, ne);
    const d = path.dirname(f.rel);
    add(dirs, d, f.rel);
  }
  const probeChanged = new Set();
  for (const [rel, record] of state.imports) if ([...record.probes].some(([file, existed]) => fs.existsSync(file) !== existed)) probeChanged.add(rel);
  if (!changed.size && !probeChanged.size && state.graph) return { ...state.graph, incremental: { ...stats, importsReused: state.imports.size, callsReused: state.calls.size, cacheHit: true } };
  const suffix = (spec) => {
    const s = spec.replace(/^\/+/, '');
    const cands = [...new Set(byBase.get(path.basename(s)) || [])].filter((ne) => ne === s || ne.endsWith('/' + s));
    return cands.length ? cands.sort().flatMap((candidate) => [...byNoExt.get(candidate)].sort()) : null;
  };
  const dirSuffix = (spec) => {
    const candidates = [...dirs.keys()].filter((d) => d !== '.' && (spec === d || spec.endsWith('/' + d))).sort();
    if (candidates.length === 1) return dirs.get(candidates[0]).filter((r) => !byRel.get(r).isTest).sort().slice(0, 20);
    return null;
  };
  const family = (l) => (isJsLang(l) ? 'js' : l);
  const sameFamily = (from, list) => { const fam = family(byRel.get(from).lang); return list.filter((r) => family(byRel.get(r).lang) === fam); };
  const relResolve = (from, spec) => { const r = relResolveAny(from, spec); return r && sameFamily(from, r); };
  const relResolveAny = (from, spec) => {
    const base = path.normalize(path.join(path.dirname(from), spec));
    if (byRel.has(base) && byRel.get(base).lang) return [base];
    const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
    for (const b of [base, stripped]) {
      if (byNoExt.has(b)) return byNoExt.get(b);
      for (const idx of ['/index', '/__init__', '/mod']) if (byNoExt.has(b + idx)) return byNoExt.get(b + idx);
    }
    return null;
  };
  let probes;
  const exists = (file) => { const value = fs.existsSync(file); probes.set(file, value); return value; };
  const existsOnDisk = (from, spec) => {
    const base = nodePath.join(root, path.dirname(from), spec);
    if (exists(base)) return true;
    return [...JS_EXTS, '.py', '.vue', '.svelte', '.css', '.scss', '.d.ts', '.node', '.rs', '.rb'].some((e) => exists(base + e))
      || exists(base.replace(/\.js$/, '.ts')) || exists(base.replace(/\.js$/, '.tsx'));
  };

  const fileEdges = new Map();     // rel -> Set(rel)
  const packages = new Map();      // rel -> Set(paquete externo)
  const missing = [];              // imports relativos que no existen
  const importTargets = new Map();
  for (const f of irs) {
    if (!f.lang) continue;
    const cached = state.imports.get(f.rel);
    if (cached?.ir === f && !topologyChanged && !probeChanged.has(f.rel)) {
      fileEdges.set(f.rel, new Set(cached.out)); packages.set(f.rel, cached.pk); importTargets.set(f.rel, cached.resolved); missing.push(...cached.missing);
      stats.importsReused++;
      continue;
    }
    probes = new Map();
    const missingStart = missing.length;
    const out = new Set();
    const pk = new Set();
    const resolved = new Map();
    for (const imp of f.imports) {
      // Los empaquetadores admiten sufijos como «./estilo.css?url»: no forman parte de la ruta.
      const spec = imp.spec && imp.spec.replace(/[?#].*$/, '');
      if (!spec) continue;
      let targets = null;
      if (isJsLang(f.lang)) {
        if (spec.startsWith('.')) {
          targets = relResolve(f.rel, spec);
          if (!targets && !imp.optional && !existsOnDisk(f.rel, spec)) missing.push({ file: f.rel, line: imp.line, spec });
        } else if (/^[@~]\//.test(spec) || spec.startsWith('/')) targets = suffix(spec.replace(/^[@~]?\//, ''));
        else if (!spec.startsWith('node:') && !spec.includes(':') && !spec.startsWith('#')) {
          const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          if (!NODE_BUILTINS.has(name)) pk.add(name);
        }
      } else if (f.lang === 'python') {
        if (spec.startsWith('.')) {
          const dots = /^\.+/.exec(spec)[0].length;
          const rest = spec.slice(dots).replace(/\./g, '/');
          const rel = (dots === 1 ? './' : '../'.repeat(dots - 1)) + rest;
          targets = rest ? relResolve(f.rel, rel) : null;
          if (!targets && rest && !imp.optional && !existsOnDisk(f.rel, rel)) missing.push({ file: f.rel, line: imp.line, spec });
        } else targets = suffix(spec.replace(/\./g, '/')) || suffix(spec.replace(/\./g, '/') + '/__init__');
      } else if (f.lang === 'go') targets = dirSuffix(spec);
      else if (f.lang === 'c_sharp') targets = dirSuffix(spec.replace(/\./g, '/'));
      else if (f.lang === 'rust') {
        if (spec.startsWith('./')) targets = relResolve(f.rel, spec) || relResolve(f.rel, './' + path.basename(noExt(f.rel)) + '/' + spec.slice(2));
        else {
          const parts = spec.split('::').filter((p) => !/^(crate|self|super)$/.test(p));
          for (let n = parts.length; n > 0 && !targets; n--) targets = suffix(parts.slice(0, n).join('/'));
        }
      } else if (f.lang === 'ruby') targets = spec.startsWith('.') ? relResolve(f.rel, spec) : suffix(spec);
      else if (f.lang === 'php') targets = /[\/.]/.test(spec) && !spec.includes('\\') ? relResolve(f.rel, spec) : suffix(spec.replace(/\\/g, '/'));
      else targets = suffix(spec.replace(/\./g, '/'));
      if (targets) {
        targets = sameFamily(f.rel, targets);
        resolved.set(imp.spec, targets);
        if (!isJsLang(f.lang) || targets.length === 1) for (const t of targets) if (t !== f.rel) out.add(t);
      }
    }
    fileEdges.set(f.rel, out);
    packages.set(f.rel, pk);
    importTargets.set(f.rel, resolved);
    state.imports.set(f.rel, { ir: f, out: new Set(out), pk, resolved, missing: missing.slice(missingStart), probes });
  }

  // JS/TS y Python usan bindings léxicos. Los otros lenguajes conservan una aproximación por nombre.
  const callEdges = [];
  const unresolvedCalls = [];
  const unitFile = new Map();
  // Los imports son la única base fiable para ciclos; para «quién usa a quién» se añaden después llamadas y tipos.
  const importEdges = new Map([...fileEdges].map(([k, v]) => [k, new Set(v)]));
  const classFile = new Map();
  const mutatedMembers = new Set(irs.flatMap((f) => [...(f.bindings?.mutatedMembers || [])]));
  const mutationKey = JSON.stringify([...mutatedMembers].sort());
  for (const f of irs) for (const c of f.classes || []) { const k = f.lang + ':' + c; classFile.set(k, classFile.has(k) ? null : f.rel); }
  for (const f of irs) {
    const imported = importEdges.get(f.rel) || new Set();
    const own = unitsByFile.get(f.rel);
    for (const u of [...f.units, ...(f.moduleUnit ? [f.moduleUnit] : [])]) unitFile.set(u.id, f.rel);
    if (isJsLang(f.lang) || f.lang === 'python') {
      if (f.bindings) {
        const cached = state.calls.get(f.rel);
        const reusable = cached && !topologyChanged && !hierarchyChanged && state.mutationKey === mutationKey
          && ![...cached.dependencies].some((rel) => changed.has(rel) || probeChanged.has(rel));
        const resolved = reusable ? cached : resolveCalls(f, byRel, importTargets, mutatedMembers);
        if (reusable) stats.callsReused++; else stats.callsResolved++;
        state.calls.set(f.rel, resolved);
        callEdges.push(...resolved.edges);
        unresolvedCalls.push(...resolved.unresolved);
        for (const [, target] of resolved.edges) {
          const dest = fileOfUnit.get(target);
          if (dest && dest !== f.rel) fileEdges.get(f.rel).add(dest);
        }
      }
      continue;
    }
    if (!f.lang) continue;
    const genericCached = state.calls.get(f.rel);
    if (genericCached?.generic && !topologyChanged && !changed.has(f.rel) && !probeChanged.has(f.rel)
      && !genericCached.symbols.some((key) => changedSymbols.has(key))) {
      callEdges.push(...genericCached.edges); unresolvedCalls.push(...genericCached.unresolved); stats.callsReused++;
      for (const [, target] of genericCached.edges) { const dest = fileOfUnit.get(target); if (dest && dest !== f.rel) fileEdges.get(f.rel).add(dest); }
      continue;
    }
    const edgeStart = callEdges.length, unresolvedStart = unresolvedCalls.length;
    const symbols = new Set();
    stats.callsResolved++;
    for (const u of [...f.units, ...(f.moduleUnit ? [f.moduleUnit] : [])]) {
      unitFile.set(u.id, f.rel);
      for (const call of u.callSites || [...u.calls].map((name) => ({ name, receiver: null, line: u.line }))) {
        const { name, receiver } = call;
        symbols.add(f.lang + ':' + name);
        const cls = receiver === 'this' || receiver === 'self' || !receiver ? u.cls : (f.classes || []).includes(receiver) ? receiver : null;
        let targets = own.get(name)?.filter((target) => !target.cls || target.cls === cls);
        if (targets && !targets.length) targets = undefined;
        if (!targets) {
          const candidates = [...imported].flatMap((imp) => unitsByFile.get(imp)?.get(name) || []);
          if (candidates.length) targets = candidates;
        }
        if (!targets && name.length >= 4 && !COMMON_NAMES.has(name)) {
          let g = (unitsByName.get(name) || []).filter((u) => family(byRel.get(fileOfUnit.get(u.id)).lang) === family(f.lang));
          // Con un receptor explícito (una variable: «producto.precio()»), un método homónimo de otra parte del proyecto
          // solo vale si es de otra clase y ese tipo se usa en este archivo. Si no, se uniría con cualquier función del mismo nombre.
          if (receiver && receiver !== 'this' && receiver !== 'self' && IMPLICIT.has(f.lang)) g = g.filter((t) => t.cls && t.cls !== u.cls && f.idents.has(t.cls));
          if (g.length === 1) targets = g;
        }
        if (targets?.length === 1) {
          const target = targets[0];
          callEdges.push([u.id, target.id]);
          const dest = fileOfUnit.get(target.id);
          if (dest && dest !== f.rel) fileEdges.get(f.rel).add(dest);
        } else unresolvedCalls.push({ file: f.rel, line: call.line });
      }
    }
    state.calls.set(f.rel, { generic: true, symbols: [...symbols], edges: callEdges.slice(edgeStart), unresolved: unresolvedCalls.slice(unresolvedStart) });
  }
  // Swift, Kotlin, Java, C# y Go ven otros archivos del mismo módulo sin importarlos: se enlaza por uso de tipos.
  for (const f of irs) {
    if (!IMPLICIT.has(f.lang)) continue;
    const out = fileEdges.get(f.rel);
    for (const name of f.idents.keys()) { const to = name.length >= 4 && classFile.get(f.lang + ':' + name); if (to && to !== f.rel) out.add(to); }
  }
  // Import con nombre que el archivo de destino no exporta. Solo se afirma cuando es demostrable:
  // un único destino JS/TS, sin `export *` ni CommonJS, y el nombre ni siquiera aparece en ese archivo.
  const brokenImports = [];
  for (const f of irs) {
    if (!isJsLang(f.lang) || !f.bindings) continue;
    for (const [local, ref] of f.bindings.scopes[0].names) {
      if (ref.kind !== 'import' || ref.name === '*' || ref.name === 'default') continue;
      const targets = importTargets.get(f.rel)?.get(ref.spec);
      if (targets?.length !== 1) continue;
      const dest = byRel.get(targets[0]);
      if (!dest?.bindings || !dest.parsed || dest.syntaxError || !isJsLang(dest.lang) || /\.(vue|svelte|html?)$/.test(dest.rel)) continue;
      if (dest.bindings.exports.has(ref.name) || dest.bindings.exportStars.length || dest.idents.has(ref.name) || dest.idents.has('module') || dest.idents.has('exports')) continue;
      const line = (f.imports.find((imp) => imp.spec === ref.spec) || {}).line || 1;
      brokenImports.push({ file: f.rel, line, spec: ref.spec, name: ref.name, local, dest: dest.rel });
    }
  }
  state.irs = byRel;
  state.mutationKey = mutationKey;
  state.graph = { fileEdges, importEdges, packages, missing, brokenImports, callEdges, unresolvedCalls, unitsByName, unitFile, byRel, incremental: stats };
  return state.graph;
}

/** Componentes fuertemente conexas (Tarjan iterativo). Devuelve solo ciclos reales. */
function findCycles(edges) {
  const index = new Map(), low = new Map(), on = new Set(), st = [], out = [];
  let n = 0;
  for (const startNode of edges.keys()) {
    if (index.has(startNode)) continue;
    const work = [[startNode, [...(edges.get(startNode) || [])], 0]];
    index.set(startNode, n); low.set(startNode, n); n++; st.push(startNode); on.add(startNode);
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, succ] = frame;
      if (frame[2] < succ.length) {
        const w = succ[frame[2]++];
        if (!index.has(w)) {
          index.set(w, n); low.set(w, n); n++; st.push(w); on.add(w);
          work.push([w, [...(edges.get(w) || [])], 0]);
        } else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      } else {
        work.pop();
        if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p), low.get(v))); }
        if (low.get(v) === index.get(v)) {
          const comp = [];
          let w;
          do { w = st.pop(); on.delete(w); comp.push(w); } while (w !== v);
          if (comp.length > 1) out.push(comp.reverse());
        }
      }
    }
  }
  return out;
}

/** Archivos alcanzables desde los tests siguiendo imports. */
function reachableFromTests(irs, fileEdges) {
  const direct = new Set(), seen = new Set();
  const queue = [];
  for (const f of irs) if (f.isTest) { seen.add(f.rel); queue.push(f.rel); for (const t of fileEdges.get(f.rel) || []) direct.add(t); }
  while (queue.length) {
    const v = queue.pop();
    for (const w of fileEdges.get(v) || []) if (!seen.has(w)) { seen.add(w); queue.push(w); }
  }
  return { direct, reachable: seen };
}

module.exports = { buildGraph, findCycles, reachableFromTests, NODE_BUILTINS };
