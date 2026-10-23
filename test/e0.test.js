'use strict';
// Regresiones de la entrega E0 (fiabilidad y alcance): una por cada corrección FIX-01 a FIX-10 del plan maestro.
// Cada prueba describe el comportamiento observable, no la estructura interna.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { Engine } = require('../src/core');
const { EngineClient } = require('../src/core/client');
const { ROOT, project, ui, activate, sleep, until } = require('./helpers');

const TWO_PARTS = {
  'api/pyproject.toml': '[project]\nname = "api"\n', 'api/app.py': 'def hola():\n    return 1\n',
  'web/package.json': '{"name":"tienda-web"}', 'web/src/cart.js': 'export function total(a) { return a; }\n',
  'web/src/main.js': "import { total } from './cart.js';\nconsole.log(total(1));\n",
};
const scan = async (root, opts) => JSON.parse(JSON.stringify(await new Engine(root).scan(opts)));
const ABSOLUTE = /está correcto|Todo verificado|Verificado|verificado/;

test('FIX-01: un resultado sin avisos no afirma que el proyecto esté correcto', async (t) => {
  const data = await scan(project(t, TWO_PARTS));
  data.findings = []; data.counts = { fail: 0, risk: 0, human: 0 }; data.verdict = 'pass';
  for (const c of data.categories) c.fail = c.risk = c.human = 0;
  const page = ui(data);
  assert.match(page.text(), /Sin problemas detectados en lo analizado/);
  assert.doesNotMatch(page.text(), ABSOLUTE);
  page.scope('web');
  assert.match(page.text(), /«tienda-web»: sin problemas detectados en lo analizado/);
  for (const tab of ['Problemas', 'Mapa', 'Backend', 'Código', 'Reglas', 'Actividad', 'Cronología', 'API y logs', 'App en marcha']) { page.button(tab).events.click(); assert.doesNotMatch(page.text(), ABSOLUTE, tab); }
  page.button('Profesional').events.click();
  for (const tab of ['Resumen', 'Actividad', 'Problemas', 'Mapa', 'Código', 'Reglas']) { page.button(tab).events.click(); assert.doesNotMatch(page.text(), ABSOLUTE, tab + ' (técnico)'); }
  // La CLI y la barra lateral usan el mismo vocabulario.
  for (const file of ['src/cli.js', 'src/extension.js']) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), /t`(Todo verificado|verificado)`/, file);
});

test('FIX-02: al filtrar una parte, el análisis incompleto y los avisos globales siguen a la vista', async (t) => {
  const data = await scan(project(t, { ...TWO_PARTS, 'api/bundle.js': 'const value = 1;'.repeat(100) }));
  assert.equal(data.stats.complete, false);
  const page = ui(data);
  page.scope('web');
  for (const tab of ['Resumen', 'Problemas', 'Mapa', 'Reglas', 'Actividad']) {
    page.button(tab).events.click();
    assert.match(page.text(), /El análisis del proyecto está incompleto: 1 archivos o carpetas sin analizar/, tab);
  }
  assert.match(page.text(), /Avisos de todo el proyecto que no se cuentan en esta parte: \d+\./);
  page.button('Resumen').events.click();
  assert.doesNotMatch(page.text(), /«tienda-web» tiene/, 'el aviso global no se suma a los de la parte');
  // «Ver detalle» lleva al aviso en el proyecto entero.
  page.button('Ver detalle').events.click();
  assert.match(page.text(), /Revisar los archivos omitidos y los límites del análisis/);
  assert.doesNotMatch(page.text(), /\[object |null|undefined/);
});

test('FIX-03: trace termina con el resultado del programa y distingue cancelación y fallo de arranque', async (t) => {
  const root = project(t, { 'siete.js': 'process.exit(7);\n', 'bien.js': '', 'espera.js': "console.log('listo'); setTimeout(() => {}, 60000);\n" });
  const cli = (...args) => childProcess.spawnSync(process.execPath, [path.join(ROOT, 'src/cli.js'), 'trace', root, '--', ...args], { encoding: 'utf8' });
  assert.equal(cli('node', 'siete.js').status, 7);
  assert.equal(cli('node', 'bien.js').status, 0);
  assert.equal(cli('node', 'no-existe.js').status, 1, 'un programa que no arranca tampoco es un éxito');

  // Cancelar con Ctrl+C detiene el programa y sale con 130. Windows no tiene señales: kill('SIGINT') termina el
  // proceso sin avisarle, así que allí solo un Ctrl+C real en la consola lo comprueba.
  if (process.platform !== 'win32') {
    const child = childProcess.spawn(process.execPath, ['--liftoff-only', path.join(ROOT, 'src/cli.js'), 'trace', root, '--', 'node', 'espera.js'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    const exit = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    await until(() => output.includes('listo'));
    child.kill('SIGINT');
    assert.deepEqual(await exit, { code: 130, signal: null });
  }

  // Si el comando no llega a iniciarse, se informa el error y no queda guardado como una ejecución.
  const gone = path.join(root, 'no-existe');
  const data = await new Promise((resolve) => new Engine(gone).trace('node x.js', { onExit: resolve }));
  assert.equal(data.exitCode, null);
  assert.ok(data.error);
  assert.equal(fs.existsSync(gone), false);
});

/** Sustituye los programas externos por respuestas preparadas: `tools` asigna a cada comando su (cwd) => [error, stdout]. */
function adapters(t, tools) {
  t.mock.method(childProcess, 'execFile', (cmd, args, options, callback) => {
    const tool = tools[cmd.replace(/\.cmd$/, '')];
    if (!tool) return callback(Object.assign(new Error('missing'), { code: 'ENOENT' }), '', '');
    const [error, stdout] = tool(options.cwd);
    callback(error, stdout, '');
  });
  const mod = require.resolve('../src/core/adapters');
  delete require.cache[mod];
  t.after(() => { delete require.cache[mod]; });
  return require('../src/core/adapters').runAdapters;
}
const exited = (code) => Object.assign(new Error('exit ' + code), { code });

test('FIX-04: npm audit declara su presupuesto y las carpetas que quedan sin auditar', async (t) => {
  const files = {};
  for (let i = 1; i <= 7; i++) { files[`p${i}/package.json`] = '{}'; files[`p${i}/package-lock.json`] = '{}'; }
  const root = project(t, files);
  const list = (n) => Object.keys(files).filter((rel) => Number(rel[1]) <= n).map((rel) => ({ rel, abs: path.join(root, rel) }));
  let broken = '';
  const run = adapters(t, { npm: (cwd) => (path.basename(cwd) === broken ? [exited(1), 'sin red'] : [null, '{"vulnerabilities":{}}']) });
  const audit = async (n) => (await run(root, list(n))).tools.find((tool) => tool.name === 'npm audit');

  const partial = await audit(7);
  assert.equal(partial.ok, false, 'cinco de siete no es un análisis total');
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.scope, { total: 7, done: ['p1', 'p2', 'p3', 'p4', 'p5'], failed: [], pending: ['p6', 'p7'] });
  assert.match(partial.detail, /5 de 7 .*p6, p7/);

  const whole = await audit(5);
  assert.equal(whole.ok, true);
  assert.equal(whole.partial, false);

  broken = 'p2';
  const failed = await audit(3);
  assert.equal(failed.ok, false, 'una carpeta sin respuesta tampoco es un análisis total');
  assert.deepEqual(failed.scope.failed, ['p2']);
  assert.match(failed.detail, /2 de 3 .*sin respuesta: p2/);

  // En la interfaz aparece como parcial, en todas las pestañas.
  const data = await scan(root);
  data.stats.deep = true; data.stats.tools.push(partial);
  assert.match(ui(data, { tab: 'problemas' }).text(), /npm audit: parcial \(5 de 7 carpetas con dependencias auditadas/);
});

test('FIX-05: osv-scanner solo indica éxito con un informe válido y un proceso que terminó bien', async (t) => {
  const root = project(t, {});
  const report = (vulns) => JSON.stringify({ results: [{ source: { path: path.join(root, 'package-lock.json') }, packages: [{ package: { name: 'left-pad', version: '1.0.0' }, vulnerabilities: vulns }] }] });
  let scenario;
  const run = adapters(t, { 'osv-scanner': () => [scenario.code ? exited(scenario.code) : scenario.killed ? new Error('timeout') : null, scenario.out] });
  for (scenario of [
    { out: '{}', ok: false }, { out: '{}', code: 127, ok: false }, { out: '{"results":"x"}', ok: false }, { out: '{"results":[null]}', ok: false },
    { out: 'null', ok: false }, { out: '[]', ok: false }, { out: '{"results":[]}', code: 127, ok: false }, { out: '{"results":[]}', code: 128, ok: false },
    { out: '{"results":[]}', code: 1, ok: false }, { out: '{"results":[]}', killed: true, ok: false }, { out: report([{ id: 'OSV-1' }]), code: 2, ok: false },
    { out: report([{ id: 7 }]), code: 1, ok: false },
    { out: '{"results":[]}', ok: true, findings: 0 }, { out: report([{ id: 'OSV-1' }]), code: 1, ok: true, findings: 1 }, { out: report([]), ok: true, findings: 0 },
  ]) {
    const result = await run(root, []);
    const label = JSON.stringify(scenario);
    assert.equal(result.tools.find((tool) => tool.name === 'osv-scanner').ok, scenario.ok, label);
    assert.equal(result.findings.length, scenario.findings || 0, label);
  }
});

test('FIX-06: con varias carpetas, cada una tiene su análisis y sus avisos, y se puede cambiar entre ellas', async (t) => {
  const first = project(t, { 'a.js': 'eval("1");\n' });
  const second = project(t, { 'b.js': 'eval("2");\nconst x = eval("3");\n' });
  const { S, vscode } = await activate(t, [first, second]);
  assert.ok(S.status.text.endsWith(path.basename(first)), 'la barra de estado dice de qué carpeta habla');
  const row = S.tree.getChildren().find((item) => String(item.label).startsWith('Carpeta:'));
  assert.ok(row && row.command.command === 'spectator.selectFolder');
  const data = S.posted.find((m) => m.type === 'data').data;
  assert.deepEqual(data.host.roots.map((r) => [r.name, r.current]), [[path.basename(first), true], [path.basename(second), false]]);
  const page = ui(JSON.parse(JSON.stringify(data)), { tab: 'resumen' });
  assert.ok(page.all((n) => n.tag === 'select' && n.attrs['aria-label'] === 'Carpeta del área de trabajo').length, 'el panel ofrece elegir carpeta');
  assert.ok([...S.diagnostics.keys()].some((file) => file.startsWith(first)));
  assert.ok(![...S.diagnostics.keys()].some((file) => file.startsWith(second)), 'todavía no se ha analizado la segunda carpeta');

  // Cambiar a la segunda carpeta: se analiza y sus avisos se suman sin borrar los de la primera.
  S.posted.length = 0;
  await S.onMessage({ type: 'selectRoot', path: second });
  await until(() => S.posted.some((m) => m.type === 'data' && m.data.host.path === second));
  assert.ok(S.status.text.endsWith(path.basename(second)));
  assert.ok([...S.diagnostics.keys()].some((file) => file.startsWith(second)));
  assert.ok([...S.diagnostics.keys()].some((file) => file.startsWith(first)), 'los avisos de la otra carpeta siguen en el editor');

  // Un cambio en la carpeta no activa no se analiza ahora: se apunta y se analiza al volver.
  fs.writeFileSync(path.join(first, 'a.js'), 'eval("1");\neval("nuevo");\n');
  S.posted.length = 0;
  S.fsw.change(path.join(first, 'a.js'));
  await sleep(1000);
  assert.ok(!S.posted.some((m) => m.type === 'data'), 'no se analiza una carpeta que no está a la vista');
  await S.onMessage({ type: 'selectRoot', path: first });
  await until(() => S.posted.some((m) => m.type === 'data' && m.data.host.path === first));
  const back = S.posted.filter((m) => m.type === 'data').pop().data;
  assert.ok(back.findings.filter((f) => /eval/.test(f.rule) || /eval/.test(f.title)).length >= 2, 'el cambio hecho mientras tanto ya se ve');
  // Una ruta que no es una carpeta del área de trabajo no cambia nada.
  await S.onMessage({ type: 'selectRoot', path: '/tmp' });
  assert.ok(S.status.text.endsWith(path.basename(first)));
  void vscode;
});

test('FIX-07: la pertenencia al proyecto se decide por carpetas y rutas reales, no por prefijo', async (t) => {
  const root = project(t, { 'src/a.js': 'export const a = 1;\n', 'src/b.js': 'export const b = 1;\n' });
  const sibling = root + '-otro';
  fs.mkdirSync(sibling);
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }));
  fs.writeFileSync(path.join(sibling, 'secreto.js'), 'x');
  const outside = project(t, { 'fuera.js': 'x' });
  fs.symlinkSync(path.join(outside, 'fuera.js'), path.join(root, 'src/enlace-fuera.js'));
  fs.symlinkSync(outside, path.join(root, 'carpeta-fuera'));
  fs.symlinkSync(path.join(root, 'src/b.js'), path.join(root, 'src/enlace-dentro.js'));
  const { S, vscode } = await activate(t, [root]);
  const open = async (file) => { S.opened = null; await S.onMessage({ type: 'open', file, line: 1 }); return S.opened && S.opened.doc.file; };

  assert.equal(await open('src/a.js'), path.join(root, 'src/a.js'));
  assert.equal(await open('src/enlace-dentro.js'), path.join(root, 'src/enlace-dentro.js'), 'un enlace que no sale del proyecto sí se abre');
  for (const file of [`../${path.basename(sibling)}/secreto.js`, 'src/enlace-fuera.js', 'carpeta-fuera/fuera.js', path.join(root, 'src/a.js'), '../../etc/passwd', 'src', '', 'no-existe.js', null, 7, { toString: () => 'src/a.js' }]) {
    assert.equal(await open(file), null, `no abre ${JSON.stringify(file)}`);
  }
  assert.deepEqual(S.errors, [], 'una ruta inválida se ignora sin error');

  // Guardar en una carpeta hermana, o en el estado propio de Spectator, no vuelve a analizar este proyecto.
  S.posted.length = 0;
  S.onSave({ uri: vscode.Uri.file(path.join(sibling, 'secreto.js')) });
  S.onSave({ uri: vscode.Uri.file(path.join(root, '.spectator', 'baseline.json')) });
  await sleep(1000);
  assert.deepEqual(S.posted, []);
  S.onSave({ uri: vscode.Uri.file(path.join(root, 'src/a.js')) });
  await until(() => S.posted.some((m) => m.type === 'data'));
});

test('FIX-08: un trace que no arranca publica el error, cierra «En vivo» y permite reintentar', async (t) => {
  const root = project(t, { 'lib.js': 'exports.f = function f() { return 1; };\n', 'run.js': "require('./lib').f();\n", 'espera.js': "require('fs').writeFileSync('pid.txt', String(process.pid));\nsetTimeout(() => {}, 60000);\n" });
  const client = new EngineClient(root);
  t.after(() => client.dispose());
  await client.scan();
  const attempt = (command) => new Promise((resolve) => client.trace(command, { onExit: (data) => resolve({ data }), onError: (error) => resolve({ error }) }));

  const invalid = await attempt({ no: 'es un comando' });
  assert.match(invalid.error.message, /command/);
  assert.equal(client.traceHandlers, null, 'no queda una ejecución a medias');

  // El proceso del motor desaparece con una ejecución en curso.
  const running = attempt('node espera.js');
  await sleep(400);
  await until(() => fs.existsSync(path.join(root, 'pid.txt')));
  client.child.kill('SIGKILL');
  assert.equal((await running).error.message, 'analyzer-stopped');
  // El programa que ejecutaba no se queda huérfano.
  const pid = Number(fs.readFileSync(path.join(root, 'pid.txt'), 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await until(() => !alive());

  // Reintentar funciona con un proceso nuevo.
  await client.scan();
  const retry = await attempt('node run.js');
  assert.equal(retry.data.exitCode, 0);
  assert.ok(retry.data.counts['lib.js#f']);

  // Sustituir una ejecución por otra no cierra la nueva con el final de la anterior.
  client.trace('node espera.js', {});
  const second = await attempt('node run.js');
  assert.equal(second.data.command, 'node run.js');

  // En la extensión: el panel recibe el final con su error y la interfaz vuelve a ofrecer «Ver en vivo».
  const { S } = await activate(t, [root]);
  const page = ui(JSON.parse(JSON.stringify(S.posted.find((m) => m.type === 'data').data)), { tab: 'flow' });
  page.button('▶ Ver en vivo').events.click();
  assert.ok(page.button('Detener'));
  S.posted.length = 0;
  await S.onMessage({ type: 'trace', command: { no: 'es un comando' } });
  await until(() => S.posted.some((m) => m.type === 'traceEnd'));
  const end = S.posted.find((m) => m.type === 'traceEnd');
  assert.ok(end.error);
  assert.match(S.errors[0], /no pudo iniciar el flujo en vivo/);
  page.send(end);
  assert.ok(page.button('▶ Ver en vivo') && !page.button('Detener'));
  assert.match(page.text(), /No se pudo iniciar el comando/);
  S.posted.length = 0;
  await S.onMessage({ type: 'trace', command: 'node run.js' });
  await until(() => S.posted.some((m) => m.type === 'traceEnd'));
  assert.ok(S.posted.find((m) => m.type === 'traceEnd').data.counts['lib.js#f']);
});

test('FIX-09: los ids de las normas son estables y no se repiten al eliminar, añadir o reconfirmar', async (t) => {
  const root = project(t, { 'a.js': 'const A_MAX = 1;\nconst B_MAX = 2;\nconst C_MAX = 3;\nconst D_MAX = 4;\n' });
  const engine = new Engine(root);
  await engine.scan();
  const file = path.join(root, 'spectator.json');
  const rules = () => JSON.parse(fs.readFileSync(file, 'utf8')).contract;
  const ids = () => Object.fromEntries(rules().map((c) => [c.name, c.id]));
  const confirm = (name, value) => engine.confirmStatement({ file: 'a.js', line: 1, name, op: '=', value });
  const unique = () => assert.equal(new Set(rules().map((c) => c.id)).size, rules().length, JSON.stringify(rules()));

  confirm('A_MAX', 1); confirm('B_MAX', 2); confirm('C_MAX', 3);
  const first = ids();
  unique();
  confirm('A_MAX', 5);
  assert.deepEqual(ids(), first, 'reconfirmar una norma conserva su id');
  assert.equal(rules().find((c) => c.name === 'A_MAX').value, 5);

  // Eliminar una norma y añadir otra no reutiliza ni duplica ids.
  fs.writeFileSync(file, JSON.stringify({ contract: rules().filter((c) => c.name !== 'A_MAX') }));
  confirm('D_MAX', 4);
  unique();
  assert.ok(!Object.values(first).includes(ids().D_MAX));
  assert.equal(ids().B_MAX, first.B_MAX);

  // Un archivo que ya trae ids repetidos (creados por versiones anteriores) queda reparado; el primero conserva el suyo.
  fs.writeFileSync(file, JSON.stringify({ contract: [
    { id: 'R-002', name: 'B_MAX', operator: '=', value: 2, file: 'a.js' }, { id: 'R-003', name: 'C_MAX', operator: '=', value: 3, file: 'a.js' }, { id: 'R-003', name: 'A_MAX', operator: '=', value: 1, file: 'a.js' },
  ] }));
  confirm('D_MAX', 4);
  unique();
  assert.equal(ids().B_MAX, 'R-002');
  assert.equal(ids().C_MAX, 'R-003');
});

test('FIX-10: la ejecución guardada se marca desactualizada cuando el código cambia', async (t) => {
  const root = project(t, { 'lib.js': 'exports.f = function f() { return 1; };\n', 'run.js': "require('./lib').f();\n" });
  const engine = new Engine(root);
  await engine.scan();
  const live = await new Promise((resolve) => engine.trace('node run.js', { onExit: resolve }));
  assert.equal(live.freshness, 'current');
  assert.equal('files' in live, false, 'las huellas se guardan, no viajan a la interfaz');

  const same = await scan(root);
  assert.equal(same.runtime.freshness, 'current');
  assert.deepEqual(same.runtime.changedFiles, []);
  assert.equal('files' in same.runtime, false);
  assert.doesNotMatch(ui(same, { tab: 'flow' }).text(), /desactualizada|no se sabe/);

  fs.writeFileSync(path.join(root, 'lib.js'), 'exports.f = function f() { return 2; };\n');
  const edited = await scan(root);
  assert.equal(edited.runtime.freshness, 'stale');
  assert.deepEqual(edited.runtime.changedFiles, ['lib.js']);
  assert.match(ui(edited, { tab: 'flow' }).text(), /Última ejecución: 1 de 1 funciones · desactualizada: el código cambió después de ejecutarla/);
  // El mismo motor, con su caché, llega a la misma conclusión.
  assert.equal((await engine.scan()).runtime.freshness, 'stale');

  // Volver al contenido original la hace vigente otra vez; un archivo nuevo con funciones, no.
  fs.writeFileSync(path.join(root, 'lib.js'), 'exports.f = function f() { return 1; };\n');
  assert.equal((await scan(root)).runtime.freshness, 'current');
  fs.writeFileSync(path.join(root, 'nuevo.js'), 'exports.g = function g() {};\n');
  assert.deepEqual((await scan(root)).runtime.changedFiles, ['nuevo.js']);
  fs.rmSync(path.join(root, 'nuevo.js'));

  // Una ejecución guardada por una versión anterior no trae huellas: no se sabe a qué código corresponde.
  const stored = path.join(root, '.spectator/runtime.json');
  const legacy = JSON.parse(fs.readFileSync(stored, 'utf8'));
  delete legacy.files;
  fs.writeFileSync(stored, JSON.stringify(legacy));
  const old = await scan(root);
  assert.equal(old.runtime.freshness, 'unknown');
  assert.match(ui(old, { tab: 'flow' }).text(), /no se sabe si corresponde al código actual/);
  fs.writeFileSync(stored, '{"counts":7}');
  assert.equal((await scan(root)).runtime, null, 'un archivo de ejecución irreconocible se descarta');
});
