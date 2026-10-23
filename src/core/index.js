'use strict';
// Motor de Spectator. No depende de VS Code: lo usan la CLI y la extensión.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { hash, loadConfig, readJson, readJsonState, quarantine, writeJson, stateDir, updateConfig } = require('./util');
const { listFiles, scriptOnly } = require('./files');
const { parseFile, Interner } = require('./parse');
const { scanText, redactResult } = require('./textscan');
const { buildGraph } = require('./graph');
const D = require('./detectors');
const { runAdapters } = require('./adapters');
const { startTrace } = require('./runtime');
const { detectComponents } = require('./components');
const { gitChanges, describeChanges } = require('./changes');

// Avisos que hablan de cómo circula el programa (frente a cómo está escrito): la interfaz los agrupa como «fluye mal».
const FLOW_RULES = new Set(['unreachable', 'empty-catch', 'missing-import', 'broken-import', 'cycle', 'unused-function', 'unused-export',
  'await-in-loop', 'query-in-loop', 'nested-loops', 'layer-skip', 'undeclared', 'removed-export', 'signature-change']);
const { t, tr, N, setLocale, getLocale } = require('./i18n');
const { isSpringProject, springFindings } = require('./spring');
const { isExpressProject, expressFindings } = require('./express');
const { backendMap } = require('./backend');

const CATEGORIES = [
  ['correctness', N`Corrección`, N`El código hace lo que está escrito, sin errores demostrables`],
  ['security', N`Seguridad`, N`Sin credenciales expuestas ni patrones peligrosos conocidos`],
  ['duplication', N`Duplicación`, N`La misma lógica no está copiada en varios sitios`],
  ['maintainability', N`Mantenibilidad`, N`Funciones de tamaño razonable y sin código sobrante`],
  ['architecture', N`Arquitectura`, N`Las partes del proyecto se conectan de forma ordenada`],
  ['dependencies', N`Dependencias`, N`Las librerías usadas están declaradas y controladas`],
  ['testing', N`Pruebas`, N`Hay pruebas y comprueban algo de verdad`],
  ['performance', N`Rendimiento`, N`Sin patrones que se vuelven lentos con muchos datos`],
  ['contracts', N`Compatibilidad`, N`No se rompió nada que otras partes usaban`],
  ['requirements', N`Normas del proyecto`, N`El código cumple las normas que confirmaste`],
  ['context', N`Contexto y pendientes`, N`El proyecto se explica y no deja cabos sueltos`],
];

/**
 * La última ejecución guardada pertenece al código que había entonces. Se compara el contenido de cada archivo
 * con el que se registró al ejecutar: si algo cambió, la ejecución se entrega marcada como desactualizada.
 */
function runtimeView(stored, irs, hashes) {
  if (!stored || typeof stored !== 'object' || !stored.counts || typeof stored.counts !== 'object') return null;
  const { files, ...rest } = stored;
  if (!files || typeof files !== 'object') return { ...rest, freshness: 'unknown', changedFiles: [], changedCount: 0 };
  const now = new Set(irs.filter((ir) => ir.units && ir.units.length).map((ir) => ir.rel));
  const changed = [...new Set([...Object.keys(files), ...now])].filter((rel) => !now.has(rel) || files[rel] !== hashes.get(rel)).sort();
  return { ...rest, freshness: changed.length ? 'stale' : 'current', changedFiles: changed.slice(0, 20), changedCount: changed.length };
}

// Qué hace equivalentes dos análisis. Si cambia, la desaparición de un aviso puede deberse a la configuración
// o a las comprobaciones ejecutadas, no a un arreglo del código: esos avisos no cuentan como resueltos.
const ENGINE_VERSION = require('../../package.json').version;
const EXTERNAL_SOURCES = new Set(['npm audit', 'gitleaks', 'osv-scanner']);
// Cada límite solo afecta a los avisos de su área.
const LIMIT_CATEGORY = { duplicateTokens: 'duplication', duplicateLines: 'duplication' };
const canonical = (list) => JSON.stringify((list || []).map((x) => JSON.stringify(x, Object.keys(x).sort())).sort());
function comparisonDescriptor(cfg, deep) {
  return {
    engine: ENGINE_VERSION, deep: !!deep,
    exclude: [...new Set(cfg.exclude || [])].sort(),
    limits: Object.fromEntries(Object.entries(cfg.limits || {}).sort()),
    rules: canonical(cfg.contract), architecture: canonical(cfg.architecture),
  };
}
/** Compara el punto de partida con el análisis actual: qué partes son comparables y por qué no lo son las demás. */
function comparison(baseline, now, complete) {
  const reasons = [], skip = new Set();
  let none = false, external = false;
  const was = baseline.descriptor;
  if (!complete) { reasons.push('incomplete'); none = true; }
  if (!was || !Array.isArray(baseline.findings)) { reasons.push('legacy'); none = true; }
  else {
    if (was.engine !== now.engine) { reasons.push('engine'); none = true; }
    if (JSON.stringify(was.exclude) !== JSON.stringify(now.exclude)) { reasons.push('exclude'); none = true; }
    const limits = new Set([...Object.keys(was.limits || {}), ...Object.keys(now.limits)].filter((k) => (was.limits || {})[k] !== now.limits[k]));
    if (limits.size) { reasons.push('limits'); for (const k of limits) skip.add(LIMIT_CATEGORY[k] || 'maintainability'); }
    if (was.rules !== now.rules) { reasons.push('rules'); skip.add('requirements'); }
    if (was.architecture !== now.architecture) { reasons.push('architecture'); skip.add('architecture'); }
    if (was.deep !== now.deep) { reasons.push('checks'); external = true; }
  }
  const counts = (entry) => !none && !skip.has(entry[1]) && !(external && EXTERNAL_SOURCES.has(entry[2]));
  return { status: none ? 'incomparable' : reasons.length ? 'partial' : 'comparable', reasons, counts };
}

class Engine {
  constructor(root) {
    this.root = path.resolve(root);
    this.cache = new Map();
    this.interner = new Interner();
    this.irs = [];
    this.last = null;
    this.duplicationCache = null;
    this.graphState = {};
    this.localFindingsCache = new Map();
    this.hashes = null;
  }

  async scan(opts = {}) {
    const t0 = Date.now();
    const root = this.root;
    if (opts.locale) setLocale(opts.locale);
    const cfg = loadConfig(root);
    const maxFiles = opts.maxFiles ?? 5000;
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error('maxFiles must be a positive integer');
    const { files, truncated, skipped } = listFiles(root, cfg, maxFiles);
    const irs = [];
    const text = new Map();
    const alive = new Set();
    const hashes = new Map();
    let cacheHits = 0;
    for (const file of files) {
      alive.add(file.rel);
      const c = this.cache.get(file.rel);
      if (c && c.mtime === file.mtime && c.ctime === file.ctime && c.size === file.size) { cacheHits++; irs.push(c.ir); text.set(file.rel, c.text); hashes.set(file.rel, c.hash); continue; }
      let source;
      try { source = fs.readFileSync(file.abs, 'utf8'); } catch { skipped.push({ file: file.rel, reason: 'unreadable' }); continue; }
      if (source.includes('\u0000')) { skipped.push({ file: file.rel, reason: 'binary' }); continue; }
      const tr = scanText(file, source);
      const contentHash = hash(source);
      let unit = file, markup = null;
      if (file.embedded) { const s = scriptOnly(source); markup = source; source = s.source; if (s.ts) unit = { ...file, lang: 'typescript' }; }
      const ir = file.lang ? await parseFile(unit, source, this.interner)
        : { rel: file.rel, lang: null, isTest: file.isTest, lines: 0, units: [], imports: [], idents: new Map(), statements: [], local: [], todos: [], classes: [] };
      // Lo que la plantilla (HTML/Vue/Svelte) usa también cuenta como uso: evita marcar como «sin usar» un manejador de @click.
      if (markup && ir.idents) for (const m of markup.matchAll(/[A-Za-z_$][\w$]{2,}/g)) ir.idents.set(m[0], (ir.idents.get(m[0]) || 0) + 1);
      this.cache.set(file.rel, { mtime: file.mtime, ctime: file.ctime, size: file.size, ir, text: tr, hash: contentHash });
      irs.push(ir); text.set(file.rel, tr); hashes.set(file.rel, contentHash);
    }
    for (const k of this.cache.keys()) if (!alive.has(k)) this.cache.delete(k);
    this.irs = irs;

    for (const ir of irs) if (ir.lang && (!ir.parsed || ir.skipped)) skipped.push({ file: ir.rel, reason: ir.skipped ? 'minified' : 'parse-failed' });
    const complete = !truncated && !skipped.length;
    if (opts.resetBaseline && !complete) throw new Error(t`No se puede actualizar el punto de partida con un análisis incompleto.`);
    const sensitive = [...text.values()].flatMap((tr) => tr.sensitive);

    const graphStart = performance.now();
    const graph = buildGraph(root, irs, this.graphState);
    const graphMs = performance.now() - graphStart;
    const tests = D.testing(irs, graph, cfg);
    const stm = D.statements(irs, cfg);
    // Una credencial nunca se ofrece como una norma que se pueda confirmar y guardar.
    stm.statements = stm.statements.filter((s) => !text.get(s.file)?.secrets.some((secret) => secret.line === s.line)
      && !sensitive.some((secret) => String(s.value).includes(secret) || s.code.includes(secret)));
    // Los clones solo dependen de los tokens, los límites de duplicación y el idioma.
    // Conservamos plantillas: las huellas y el delta se calculan de nuevo sin mutar la caché.
    const cloneInputs = irs.filter((ir) => ir.tokens && !ir.isTest);
    const cloneKey = JSON.stringify([cfg.limits.duplicateTokens, cfg.limits.duplicateLines, getLocale()]);
    const previous = this.duplicationCache;
    const duplicationCacheHit = !!previous && previous.key === cloneKey && previous.inputs.length === cloneInputs.length
      && cloneInputs.every((ir, i) => ir === previous.inputs[i]);
    const duplicateStart = performance.now();
    if (!duplicationCacheHit) this.duplicationCache = { key: cloneKey, inputs: cloneInputs, findings: D.duplication(irs, cfg, this.interner) };
    const duplicates = structuredClone(this.duplicationCache.findings);
    const duplicationMs = performance.now() - duplicateStart;
    const localStart = performance.now(), localFindings = [];
    const localKey = JSON.stringify([getLocale(), cfg.limits]);
    const missingByFile = new Map();
    for (const missing of [...graph.missing, ...(graph.brokenImports || [])]) (missingByFile.get(missing.file) || missingByFile.set(missing.file, []).get(missing.file)).push(missing);
    let localCacheHits = 0;
    for (const ir of irs) {
      const missing = missingByFile.get(ir.rel) || [], missingKey = JSON.stringify(missing);
      let cached = this.localFindingsCache.get(ir.rel);
      if (cached?.ir === ir && cached.key === localKey && cached.missingKey === missingKey) localCacheHits++;
      else {
        cached = { ir, key: localKey, missingKey, findings: [
          ...D.localFindings([ir], text, { missing }), ...D.maintainability([ir], cfg), ...D.performance([ir]),
        ] };
        this.localFindingsCache.set(ir.rel, cached);
      }
      localFindings.push(...cached.findings.map((finding) => ({ ...finding })));
    }
    for (const rel of this.localFindingsCache.keys()) if (!graph.byRel.has(rel)) this.localFindingsCache.delete(rel);
    const localMs = performance.now() - localStart;
    // Mapa del backend (endpoints, DTO, qué llama a qué) y los errores típicos que salen de él.
    let backend = null, backendError = null;
    try { backend = backendMap(root, D.F); } catch (e) { backendError = String((e && e.message) || e); }
    let findings = [
      ...localFindings, ...D.deadCode(irs, graph, cfg), ...duplicates,
      ...D.architecture(irs, graph, cfg), ...D.dependencies(root, files, irs, graph), ...tests.findings,
      ...stm.findings, ...D.context(root, irs, cfg, stm.statements),
      ...(isSpringProject(root) ? springFindings(root, D.F) : []),
      ...(isExpressProject(root) ? expressFindings(root, D.F) : []),
      ...(backend ? backend.findings : []),
    ];
    let tools = [{ name: 'tree-sitter', ok: complete, detail: t`análisis sintáctico` }];
    // Un fallo del mapa del backend no se oculta: se declara como herramienta que no funcionó.
    if (backendError) tools.push({ name: 'backend-map', ok: false, detail: backendError });
    if (opts.deep) {
      const ext = await runAdapters(root, files);
      findings.push(...ext.findings);
      tools = tools.concat(ext.tools);
    }
    if (!complete) findings.push(D.F('context', 'incomplete-analysis', 'risk', 'spectator.json', 1, 'incomplete', {
      scope: 'project', confidence: 100,
      title: t`El análisis está incompleto`,
      why: t`Hay archivos que no se pudieron analizar. La ausencia de avisos no garantiza que estén correctos.`,
      action: t`Revisar los archivos omitidos y los límites del análisis.`,
      tech: t`${skipped.length} archivos o carpetas omitidos`,
      evidence: [...skipped.slice(0, 20).map((s) => `${s.file}: ${s.reason}`), ...(truncated ? [t`Análisis parcial: se alcanzó el máximo de archivos`] : [])],
    }));

    // Tope por regla: un proyecto enorme no debe generar miles de avisos idénticos (se informa cuántos quedaron fuera).
    const perRule = new Map();
    let capped = 0;
    findings = findings.filter((f) => { const n = (perRule.get(f.rule) || 0) + 1; perRule.set(f.rule, n); if (n > 200) { capped++; return false; } return true; });

    // Huellas estables (no dependen del número de línea) para comparar entre análisis.
    const seenFp = new Map();
    for (const f of findings) {
      let fp = hash([f.category, f.rule, f.file, f.key].join('|'));
      const n = seenFp.get(fp) || 0;
      seenFp.set(fp, n + 1);
      if (n) fp = hash(fp + '#' + n);
      f.id = f.fingerprint = fp;
      delete f.key;
    }

    // Punto de partida: se crea solo la primera vez; después sirve para decir «esto es nuevo».
    const exportsNow = {};
    for (const f of irs) {
      if (f.isTest || !f.parsed || f.syntaxError) continue;
      const ex = f.units.filter((u) => u.exported && u.topLevel);
      if (ex.length) exportsNow[f.rel] = Object.fromEntries(ex.map((u) => [u.name, u.params]));
    }
    const baseFile = path.join(stateDir(root), 'baseline.json');
    // El punto de partida dañado no se sustituye en silencio: se aparta con la fecha y se avisa. Uno de una versión
    // más nueva de Spectator no se toca: no se sabe leerlo bien y sobrescribirlo perdería información.
    const BASELINE_SCHEMA = 2;
    const read = readJsonState(baseFile);
    let baseline = read.status === 'valid' && read.data && typeof read.data === 'object' && Array.isArray(read.data.fingerprints) ? read.data : null;
    let baselineNote = null;
    if (read.status === 'invalid' || (read.status === 'valid' && !baseline)) {
      const kept = complete ? quarantine(baseFile) : null;
      baselineNote = { kind: 'damaged', kept: kept && path.relative(root, kept).split(path.sep).join('/'), error: read.error || 'formato' };
    }
    const future = baseline && Number(baseline.schema) > BASELINE_SCHEMA;
    if (future) baselineNote = { kind: 'future', schema: baseline.schema };
    const descriptor = comparisonDescriptor(cfg, opts.deep);
    if (!baseline || opts.resetBaseline) {
      baseline = {
        schema: BASELINE_SCHEMA, createdAt: new Date().toISOString(), fingerprints: findings.map((f) => f.fingerprint), exports: exportsNow, exclude: cfg.exclude,
        descriptor, findings: findings.map((f) => [f.fingerprint, f.category, f.source]),
      };
      if (complete) writeJson(baseFile, baseline);
    }
    for (const [file, prev] of Object.entries(baseline.exports || {})) {
      const now = exportsNow[file] || {};
      const exists = graph.byRel.has(file);
      const ir = graph.byRel.get(file);
      if (ir ? (!ir.parsed || ir.syntaxError) : fs.existsSync(path.join(root, file))) continue;
      if (!complete && !ir) continue;
      for (const [name, params] of Object.entries(prev)) {
        if (!(name in now)) {
          const f = D.F('contracts', 'removed-export', 'risk', exists ? file : 'spectator.json', 1, '', {
            symbol: name, confidence: 95, title: t`Desapareció la función pública «${name}»`,
            why: t`Existía en el punto de partida. Si otras partes u otros proyectos la usaban, dejarán de funcionar; si nadie la usa, no pasa nada.`,
            action: t`Restaurarla, o confirmar que nadie la usa y marcar un nuevo punto de partida.`, tech: t`${file} ya no exporta ${name}()`,
            evidence: [t`En el punto de partida: ${file} exportaba ${name}(${params} parámetros)`, exists ? t`Ahora el archivo no la exporta` : t`Ahora el archivo no existe`],
          });
          f.id = f.fingerprint = hash('contracts|removed|' + file + '|' + name); delete f.key; findings.push(f);
        } else if (now[name] !== params) {
          const f = D.F('contracts', 'signature-change', 'risk', file, (graph.unitsByName.get(name) || []).find((u) => graph.unitFile.get(u.id) === file)?.line, '', {
            symbol: name, confidence: 90, title: t`Cambió la forma de usar la función «${name}»`,
            why: t`Ahora recibe una cantidad distinta de datos. Quien la llamaba de la forma antigua puede fallar o comportarse mal.`,
            action: t`Revisar todos los lugares que la llaman.`, tech: t`${name}: ${params} → ${now[name]} parámetros`,
            evidence: [t`Punto de partida: ${params} parámetros`, t`Ahora: ${now[name]} parámetros`],
          });
          f.id = f.fingerprint = hash('contracts|sig|' + file + '|' + name); delete f.key; findings.push(f);
        }
      }
    }

    const ignore = new Set(cfg.ignore || []);
    const ignored = findings.filter((f) => f.rule !== 'incomplete-analysis' && ignore.has(f.fingerprint)).length;
    findings = findings.filter((f) => f.rule === 'incomplete-analysis' || !ignore.has(f.fingerprint));
    const base = new Set(baseline.fingerprints);
    const current = new Set();
    for (const f of findings) { f.isNew = !base.has(f.fingerprint); current.add(f.fingerprint); }
    const cmp = comparison(baseline, descriptor, complete);
    if (future) { cmp.status = 'incomparable'; cmp.reasons.push('future'); cmp.counts = () => false; }
    if (baselineNote && baselineNote.kind === 'damaged') {
      findings.push(Object.assign(D.F('context', 'baseline-damaged', 'risk', '.spectator/baseline.json', 1, 'baseline-damaged', {
        scope: 'project', confidence: 100, title: t`El punto de partida estaba dañado y se creó uno nuevo`,
        why: t`El archivo .spectator/baseline.json no se podía leer (por ejemplo, se cortó una escritura). Hasta ahora, «nuevo» y «resuelto» se comparaban con él; a partir de este análisis se comparan con el estado actual.`,
        action: baselineNote.kept ? t`Si necesitas el anterior, está guardado en ${baselineNote.kept}.` : t`Analiza el proyecto completo para crear un punto de partida nuevo.`,
        tech: baselineNote.error, evidence: baselineNote.kept ? [baselineNote.kept] : [],
      }), { fingerprint: hash('baseline-damaged'), id: hash('baseline-damaged') }));
    }
    const fixed = (baseline.findings || []).filter((entry) => cmp.counts(entry) && !current.has(entry[0]) && !ignore.has(entry[0])).length;
    const order = { fail: 0, human: 1, risk: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity] || b.confidence - a.confidence || (a.file < b.file ? -1 : 1));

    for (const f of findings) if (FLOW_RULES.has(f.rule)) f.flow = true;
    const counts = { fail: 0, risk: 0, human: 0 };
    const perCat = Object.fromEntries(CATEGORIES.map(([id]) => [id, { fail: 0, risk: 0, human: 0 }]));
    const worst = new Map();
    for (const f of findings) {
      counts[f.severity]++; perCat[f.category][f.severity]++;
      const w = worst.get(f.file);
      if (!w || order[f.severity] < order[w]) worst.set(f.file, f.severity);
    }
    const verdict = counts.fail ? 'fail' : counts.human ? 'human' : counts.risk ? 'risk' : 'pass';

    // Grafo compacto para la vista Flow.
    const srcIrs = irs.filter((f) => f.lang);
    const fileIdx = new Map(srcIrs.map((f, i) => [f.rel, i]));
    const unitIdx = new Map();
    const units = [];
    for (const f of srcIrs) for (const u of f.units) { unitIdx.set(u.id, units.length); units.push({ id: u.id, name: u.name, cls: u.cls, f: fileIdx.get(f.rel), line: u.line, end: u.endLine, cx: u.cx }); }
    const fileEdges = [];
    // Cada conexión dice de dónde sale: un import, una llamada resuelta o el uso de un tipo (Java, Kotlin, C#…).
    // Así una aproximación por nombre de tipo no se confunde con una dependencia declarada.
    const fileEdgeKinds = [];
    const callFiles = new Set();
    for (const [a, b] of graph.callEdges) { const fa = graph.unitFile.get(a), fb = graph.unitFile.get(b); if (fa && fb && fa !== fb) callFiles.add(fa + '\u0001' + fb); }
    for (const [from, tos] of graph.fileEdges) for (const to of tos) {
      if (!fileIdx.has(from) || !fileIdx.has(to)) continue;
      fileEdges.push([fileIdx.get(from), fileIdx.get(to)]);
      fileEdgeKinds.push(graph.importEdges.get(from) && graph.importEdges.get(from).has(to) ? 'import' : callFiles.has(from + '\u0001' + to) ? 'call' : 'type');
    }
    const ce = new Set();
    const moduleCalls = [];
    for (const [a, b] of graph.callEdges) {
      if (unitIdx.has(a) && unitIdx.has(b)) ce.add(unitIdx.get(a) + ',' + unitIdx.get(b));
      else if (unitIdx.has(b)) moduleCalls.push([fileIdx.get(graph.unitFile.get(a)), unitIdx.get(b)]);
    }
    const languages = {};
    let lines = 0;
    for (const f of srcIrs) { languages[f.lang] = (languages[f.lang] || 0) + 1; lines += f.lines; }
    const runtime = runtimeView(readJson(path.join(root, '.spectator', 'runtime.json')), irs, hashes);

    const result = {
      version: 1, root, name: path.basename(root), scannedAt: new Date().toISOString(), durationMs: 0, verdict, counts,
      locale: getLocale(),
      categories: CATEGORIES.map(([id, label, desc]) => ({ id, label: tr(label), desc: tr(desc), ...perCat[id] })),
      findings, statements: stm.statements,
      graph: {
        files: srcIrs.map((f) => ({ rel: f.rel, lang: f.lang, lines: f.lines, test: f.isTest, sev: worst.get(f.rel) || null })),
        fileEdges, fileEdgeKinds, units, callEdges: [...ce].map((s) => s.split(',').map(Number)), moduleCalls,
        callEvidence: 'static',
        // Compacto [archivo, línea]: en proyectos reales son decenas de miles y viajan a la interfaz en cada análisis.
        unresolvedCalls: graph.unresolvedCalls.filter((c) => fileIdx.has(c.file)).map((c) => [fileIdx.get(c.file), c.line]),
      },
      components: detectComponents(root, files, cfg),
      delta: { baselineAt: baseline.createdAt, added: findings.filter((f) => f.isNew).length, fixed, comparable: cmp.status === 'comparable', comparison: cmp.status, reasons: cmp.reasons },
      stats: {
        files: files.length, sourceFiles: srcIrs.length, units: units.length, lines, languages, truncated, cacheHits, ignored, capped, complete, skipped,
        duplicationCacheHit, localCacheHits, incremental: graph.incremental, timings: { duplicationMs, graphMs, localMs },
        tests: tests.stats, tools, deep: !!opts.deep, hasContract: (cfg.contract || []).length,
        unparsed: srcIrs.filter((f) => !f.parsed && !f.skipped).length,
      },
      runtime,
      backend: backend && { ...backend, findings: undefined },
      // Qué cambió desde el análisis anterior y respecto al último commit, con su posible impacto.
      changes: null,
    };
    const gitInfo = opts.git === false ? null : gitChanges(root);
    result.changes = {
      since: this.last ? this.last.scannedAt : null,
      git: gitInfo && { branch: gitInfo.branch, total: gitInfo.total, truncated: gitInfo.truncated },
      ...describeChanges({ prevHashes: this.hashes, hashes, prevFindings: this.last && this.last.findings, findings, fileEdges: graph.fileEdges, git: gitInfo }),
    };
    this.hashes = hashes;
    this.last = redactResult(result, sensitive);
    this.last.durationMs = Date.now() - t0;
    return this.last;
  }

  setBaseline() { return this.scan({ resetBaseline: true }); }

  /** Convierte un statement en norma confirmada: a partir de aquí cualquier cambio es un conflicto demostrable. */
  confirmStatement(s, value) {
    const sensitive = [...this.cache.values()].flatMap((c) => c.text.sensitive);
    if (sensitive.some((secret) => String(value ?? s.value).includes(secret))
      || this.cache.get(s.file)?.text.secrets.some((secret) => secret.line === s.line)) {
      throw new Error(t`No se puede guardar una credencial como norma del proyecto.`);
    }
    updateConfig(this.root, (cfg) => {
      const same = (c) => c.name === s.name && (c.file || s.file) === s.file;
      const previous = (cfg.contract || []).find(same);
      cfg.contract = (cfg.contract || []).filter((c) => !same(c));
      // La identidad no depende de la posición ni del número de normas: reconfirmar conserva el id
      // y uno nuevo nunca coincide con otro existente. Los repetidos heredados se reparan al guardar.
      const used = new Set();
      const fresh = () => { let id; do id = 'R-' + crypto.randomUUID().slice(0, 8); while (used.has(id)); return id; };
      for (const c of cfg.contract) { if (c.id && used.has(c.id)) c.id = fresh(); if (c.id) used.add(c.id); }
      const id = previous && previous.id && !used.has(previous.id) ? previous.id : fresh();
      cfg.contract.push({ id, name: s.name, operator: s.op, value: value == null ? s.value : value, file: s.file, description: s.name });
    });
  }

  /** Decisión humana explícita: estos archivos quedan fuera del análisis (p. ej. código generado o minificado). */
  excludeFiles(list) {
    const known = new Set((this.last?.stats.skipped || []).map((s) => s.file));
    const add = (list || []).filter((f) => typeof f === 'string' && known.has(f));
    if (add.length) updateConfig(this.root, (cfg) => { cfg.exclude = [...new Set([...(cfg.exclude || []), ...add])]; });
    return add.length;
  }

  ignoreFinding(fingerprint) {
    updateConfig(this.root, (cfg) => { cfg.ignore = [...new Set([...(cfg.ignore || []), fingerprint])]; });
  }

  /** Ejecuta un comando Node.js y emite, en vivo, qué funciones del proyecto se están ejecutando. */
  trace(command, handlers) { return startTrace(this.root, command, this.irs, handlers); }
}

module.exports = { Engine, CATEGORIES };
