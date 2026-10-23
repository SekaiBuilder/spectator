'use strict';
// Regresiones de la revisión técnica del 16 de octubre de 2026 (docs/REVISION_MEJORAS_2026-10-16.md).
// Cada prueba lleva el identificador del hallazgo que cubre.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { Engine } = require('../src/core');
const { EngineClient } = require('../src/core/client');
const { ROOT, project, activate, until } = require('./helpers');

const write = (root, file, data) => fs.writeFileSync(path.join(root, file), typeof data === 'string' ? data : JSON.stringify(data));

test('M01: cambiar la configuración no cuenta como reparación; arreglar el código sí', async (t) => {
  const root = project(t, { 'a.js': 'export function many(a, b, c, d, e, f, g) { return a; }\n', 'b.js': 'export function x() { eval("1"); }\n' });
  const engine = new Engine(root);
  const first = await engine.scan();
  assert.ok(first.findings.some((f) => f.rule === 'complex-function'));
  assert.equal(first.delta.comparison, 'comparable');

  // Relajar un límite: el aviso desaparece, pero no está resuelto.
  write(root, 'spectator.json', { limits: { params: 20 } });
  const relaxed = await engine.scan();
  assert.ok(!relaxed.findings.some((f) => f.rule === 'complex-function'));
  assert.equal(relaxed.delta.fixed, 0);
  assert.equal(relaxed.delta.comparison, 'partial');
  assert.deepEqual(relaxed.delta.reasons, ['limits']);
  // Un arreglo real en otra área sí cuenta aunque la comparación sea parcial.
  write(root, 'b.js', 'export function x() { return 1; }\n');
  const repaired = await engine.scan();
  assert.equal(repaired.delta.fixed, 1);

  // Exclusiones equivalentes en otro orden no invalidan la comparación.
  write(root, 'spectator.json', { exclude: ['x/**', 'y/**'] });
  await engine.scan({ resetBaseline: true });
  write(root, 'spectator.json', { exclude: ['y/**', 'x/**', 'x/**'] });
  assert.equal((await engine.scan()).delta.comparison, 'comparable');
  // Exclusiones distintas, sí.
  write(root, 'spectator.json', { exclude: ['x/**'] });
  const scoped = await engine.scan();
  assert.equal(scoped.delta.comparison, 'incomparable');
  assert.equal(scoped.delta.fixed, 0);

  // Un punto de partida de una versión anterior no se compara a ciegas.
  fs.rmSync(path.join(root, 'spectator.json'));
  const file = path.join(root, '.spectator/baseline.json');
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete legacy.descriptor; delete legacy.findings;
  fs.writeFileSync(file, JSON.stringify(legacy));
  const old = await engine.scan();
  assert.equal(old.delta.comparison, 'incomparable');
  assert.ok(old.delta.reasons.includes('legacy'));
});

test('M01: pasar de análisis profundo a normal no resuelve los avisos de las herramientas externas', async (t) => {
  const root = project(t, { 'a.js': 'export const a = 1;\n' });
  const engine = new Engine(root);
  await engine.scan({ resetBaseline: true });
  const file = path.join(root, '.spectator/baseline.json');
  const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
  baseline.descriptor.deep = true;
  baseline.findings.push(['externo1', 'dependencies', 'npm audit'], ['interno1', 'correctness', 'spectator']);
  fs.writeFileSync(file, JSON.stringify(baseline));
  const now = await engine.scan();
  assert.equal(now.delta.comparison, 'partial');
  assert.deepEqual(now.delta.reasons, ['checks']);
  assert.equal(now.delta.fixed, 1, 'solo cuenta el aviso propio que desapareció');
});

function adapters(t, impl) {
  t.mock.method(childProcess, 'execFile', impl);
  const mod = require.resolve('../src/core/adapters');
  delete require.cache[mod];
  t.after(() => { delete require.cache[mod]; });
  return require('../src/core/adapters').runAdapters;
}
const exited = (code) => Object.assign(new Error('exit ' + code), { code });
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });

test('M03: npm audit no acepta salidas de procesos fallidos ni informes con entradas inválidas', async (t) => {
  const root = project(t, { 'package.json': '{}', 'package-lock.json': '{}' });
  const files = ['package.json', 'package-lock.json'].map((rel) => ({ rel, abs: path.join(root, rel) }));
  const vuln = (extra) => JSON.stringify({ vulnerabilities: { lodash: { severity: 'high', via: [{ title: 'Prototype pollution', url: 'https://example.test/a' }], range: '<4', ...extra } } });
  let scenario;
  const run = adapters(t, (cmd, args, options, callback) => {
    if (!/npm/.test(cmd)) return callback(missing(), '', '');
    if (scenario.throws) throw new Error('fallo inesperado');
    callback(scenario.code === undefined ? null : scenario.code === null ? new Error('timeout') : exited(scenario.code), scenario.out, '');
  });
  for (scenario of [
    { out: vuln(), code: 2, ok: false }, { out: vuln({ via: 'x' }), code: 1, ok: false }, { out: vuln({ severity: 'grave' }), code: 1, ok: false },
    { out: '{"vulnerabilities":{}}', code: 1, ok: false }, { out: vuln(), code: null, ok: false }, { out: '{"error":{"code":"ENOLOCK"},"vulnerabilities":{}}', ok: false },
    { out: '{"vulnerabilities":{}}', ok: true, findings: 0 }, { out: vuln(), code: 1, ok: true, findings: 1 },
  ]) {
    const result = await run(root, files);
    const tool = result.tools.find((x) => x.name === 'npm audit');
    assert.equal(tool.ok, scenario.ok, JSON.stringify(scenario));
    assert.equal(result.findings.length, scenario.findings || 0, JSON.stringify(scenario));
  }
  // Un fallo inesperado conserva el nombre de la herramienta.
  scenario = { throws: true };
  const broken = await run(root, files);
  assert.ok(broken.tools.some((x) => x.name === 'npm audit' && !x.ok));
  assert.ok(!broken.tools.some((x) => x.name === '?'));
});

test('M09: el mismo paquete vulnerable en dos proyectos conserva las dos ubicaciones', async (t) => {
  const root = project(t, { 'a/package.json': '{}', 'a/package-lock.json': '{}', 'b/package.json': '{}', 'b/package-lock.json': '{}' });
  const files = ['a/package.json', 'a/package-lock.json', 'b/package.json', 'b/package-lock.json'].map((rel) => ({ rel, abs: path.join(root, rel) }));
  const run = adapters(t, (cmd, args, options, callback) => (/npm/.test(cmd)
    ? callback(exited(1), JSON.stringify({ vulnerabilities: { lodash: { severity: 'high', via: [] } } }), '')
    : callback(missing(), '', '')));
  const result = await run(root, files);
  assert.deepEqual(result.findings.map((f) => f.file).sort(), ['a/package.json', 'b/package.json']);
});

test('M04: un programa que no se pudo observar no se guarda como «cero funciones»', async (t) => {
  const root = project(t, { 'lib.js': 'exports.f = function f() { return 1; };\n' });
  const engine = new Engine(root);
  await engine.scan();
  // «echo» no es Node.js: termina bien, pero no abre ningún inspector.
  const blind = await new Promise((resolve) => engine.trace('echo hola', { onExit: resolve }));
  assert.equal(blind.exitCode, 0);
  assert.equal(blind.instrumentation, 'unavailable');
  assert.equal(blind.instrumentationReason, 'no-inspector');
  assert.equal(fs.existsSync(path.join(root, '.spectator/runtime.json')), false, 'no sustituye a la última ejecución válida');

  // Si el código cambia mientras se ejecuta, el resultado llega marcado como desactualizado.
  write(root, 'run.js', "require('./lib').f();\nrequire('fs').appendFileSync(require('path').join(__dirname, 'lib.js'), '// editado\\n');\n");
  const edited = await new Promise((resolve) => engine.trace('node run.js', { onExit: resolve }));
  assert.equal(edited.instrumentation, 'recorded');
  assert.equal(edited.freshness, 'stale');
  assert.deepEqual(edited.changedFiles, ['lib.js']);
});

test('M04/M12: la CLI conserva argumentos con espacios y opciones del programa, y avisa si no pudo observar', (t) => {
  const root = project(t, { 'args.js': 'console.log(JSON.stringify(process.argv.slice(2)));\n' });
  const cli = (...args) => childProcess.spawnSync(process.execPath, [path.join(ROOT, 'src/cli.js'), 'trace', root, '--', ...args], { encoding: 'utf8', env: { ...process.env, SPECTATOR_LANG: 'es' } });
  const r = cli('node', 'args.js', 'a b', '--lang', 'ja', 'ñandú "x"');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(JSON.stringify(['a b', '--lang', 'ja', 'ñandú "x"'])), r.stdout);
  const blind = cli('echo', 'hola');
  assert.equal(blind.status, 2);
  assert.match(blind.stderr, /no se pudo observar/);
});

test('M08: un ciclo de imports es un riesgo, no un fallo demostrado', async (t) => {
  const root = project(t, { 'a.js': "import { b } from './b.js';\nexport const a = () => b;\n", 'b.js': "import { a } from './a.js';\nexport const b = () => a;\n" });
  const cycle = (await new Engine(root).scan()).findings.find((f) => f.rule === 'cycle');
  assert.equal(cycle.severity, 'risk');
});

test('M06: cerrar el cliente no deja solicitudes ni ejecuciones esperando', async (t) => {
  const root = project(t, { 'a.js': 'export const a = 1;\n', 'espera.js': 'setTimeout(() => {}, 60000);\n' });
  const client = new EngineClient(root);
  const scanning = client.scan();
  let traceError = null;
  client.trace('node espera.js', { onError: (e) => { traceError = e; } });
  client.dispose();
  await assert.rejects(scanning, /analyzer-disposed/);
  assert.match(traceError.message, /analyzer-disposed/);
  await assert.rejects(client.scan(), /analyzer-disposed/, 'un cliente cerrado no se reutiliza');
});

test('M02: un análisis profundo o un nuevo punto de partida no se pierden detrás de otro análisis', async (t) => {
  const root = project(t, { 'a.js': 'export const a = 1;\n' });
  const { S, vscode } = await activate(t, [root]);
  S.posted.length = 0;
  // Mientras un análisis está en marcha llegan un punto de partida, un profundo y un guardado.
  const running = S.onMessage({ type: 'scan' });
  const baseline = S.onMessage({ type: 'setBaseline' });
  const deep = S.onMessage({ type: 'deepScan' });
  S.onSave({ uri: vscode.Uri.file(path.join(root, 'a.js')) });
  await Promise.all([running, baseline, deep]);
  await until(() => S.posted.some((m) => m.type === 'data' && m.data.stats.deep));
  assert.ok((S.infos || []).some((m) => /punto de partida actualizado/.test(m)), 'quien pidió el punto de partida recibe su resultado');
});

test('M10: un punto de partida dañado se aparta y se avisa; uno de una versión más nueva no se sobrescribe', async (t) => {
  const root = project(t, { 'a.js': 'export const a = 1;\n' });
  const engine = new Engine(root);
  await engine.scan();
  const file = path.join(root, '.spectator/baseline.json');
  fs.writeFileSync(file, '{"fingerprints": [');
  const damaged = await engine.scan();
  const note = damaged.findings.find((f) => f.rule === 'baseline-damaged');
  assert.ok(note, 'se avisa del punto de partida dañado');
  const kept = fs.readdirSync(path.join(root, '.spectator')).find((n) => n.startsWith('baseline.json.danado-'));
  assert.ok(kept, 'el archivo dañado se conserva para poder recuperarlo');
  assert.equal(fs.readFileSync(path.join(root, '.spectator', kept), 'utf8'), '{"fingerprints": [');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).fingerprints, 'y hay uno nuevo válido');

  fs.writeFileSync(file, JSON.stringify({ schema: 99, fingerprints: [], futuro: 'dato que no conocemos' }));
  const fut = await engine.scan();
  assert.equal(fut.delta.comparison, 'incomparable');
  assert.ok(fut.delta.reasons.includes('future'));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).futuro, 'dato que no conocemos', 'no se pierde lo que escribió una versión más nueva');
});

test('M10: dos cambios a la vez en spectator.json no se pisan y un bloqueo abandonado se retira', (t) => {
  const { updateConfig, withLock } = require('../src/core/util');
  const root = project(t, { 'a.js': '1\n' });
  const file = path.join(root, 'spectator.json');
  // Un bloqueo de otro proceso que murió hace rato no impide escribir.
  fs.writeFileSync(file + '.lock', '12345');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(file + '.lock', old, old);
  updateConfig(root, (c) => { c.ignore = ['a']; });
  // Mientras alguien tiene el bloqueo, una escritura espera y luego aplica su cambio sobre el resultado del otro.
  withLock(file, () => fs.writeFileSync(file, JSON.stringify({ ignore: ['a', 'b'] })));
  updateConfig(root, (c) => { c.ignore = [...c.ignore, 'c']; });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).ignore, ['a', 'b', 'c']);
  assert.equal(fs.existsSync(file + '.lock'), false);
});

test('M05: la carga de un archivo no se cuenta como si fuera su primera función', async (t) => {
  const root = project(t, {
    'hola.js': "function hola() { return 1; }\nmodule.exports = { hola };\n",
    'run.js': "const { hola } = require('./hola');\nfor (let i = 0; i < 3; i++) hola();\n",
  });
  const engine = new Engine(root);
  await engine.scan();
  const live = await new Promise((resolve) => engine.trace('node run.js', { onExit: resolve }));
  assert.equal(live.exitCode, 0);
  assert.equal(live.counts['hola.js#hola'], 3, 'tres llamadas, no tres más la carga del módulo');
});

test('M07: cada conexión entre archivos dice si es un import, una llamada o solo un tipo', async (t) => {
  const root = project(t, {
    'a.js': "import { b } from './b';\nexport function a() { return b(); }\n",
    'b.js': 'export function b() { return 1; }\n',
    'src/main/java/demo/Pedido.java': 'package demo;\npublic class Pedido { public int total() { return 1; } }\n',
    'src/main/java/demo/Caja.java': 'package demo;\npublic class Caja { public Pedido ultimo; }\n',
  });
  const r = await new Engine(root).scan();
  const g = r.graph;
  assert.equal(g.fileEdgeKinds.length, g.fileEdges.length);
  const kind = (a, b) => g.fileEdgeKinds[g.fileEdges.findIndex(([x, y]) => g.files[x].rel.endsWith(a) && g.files[y].rel.endsWith(b))];
  assert.equal(kind('a.js', 'b.js'), 'import');
  const java = kind('Caja.java', 'Pedido.java');
  if (java) assert.equal(java, 'type', 'Caja solo usa el tipo Pedido: no hay import ni llamada');
});
