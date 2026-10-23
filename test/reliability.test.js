'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../src/core');
const { buildReport } = require('../src/report');
const { parseFile, Interner } = require('../src/core/parse');
const { updateConfig, writeJson } = require('../src/core/util');

function project(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectator-reliability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries({ 'README.md': 'Fixture', ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  return root;
}

test('las credenciales no salen en JSON, HTML, fragmentos ni normas confirmables', async (t) => {
  const password = 'UniqueDemoValue7Z';
  const token = 'ghp_' + 'Abcdef1234'.repeat(20);
  const other = 'AnotherDemoValue9X';
  const root = project(t, { 'index.js': `const PASSWORD = "${password}"; const API_SECRET = "${other}"; eval("1+1");\nconst TOKEN = "${token}"; eval(TOKEN);\n` });
  const engine = new Engine(root);
  for (let i = 0; i < 2; i++) {
    const result = await engine.scan();
    for (const output of [JSON.stringify(result), buildReport(result)]) {
      assert.ok(!output.includes(password));
      assert.ok(!output.includes(other));
      assert.ok(!output.includes(token.slice(0, 16)), 'también se oculta un token cortado por el límite del fragmento');
    }
    assert.ok(result.findings.some((f) => f.rule.startsWith('secret:')));
    assert.equal(result.statements.length, 0);
  }
  assert.throws(() => engine.confirmStatement({ file: 'index.js', line: 1, name: 'PASSWORD', op: '=', value: password }), /credencial/);
  assert.equal(fs.existsSync(path.join(root, 'spectator.json')), false);
});

test('detecta nodos faltantes y conserva los errores sintácticos de ESM', async () => {
  for (const source of ['function broken() {\n return 1;\n', 'const obj = { a: 1;\n', 'import x from "x";\nconst broken = ;\n']) {
    const ir = await parseFile({ rel: 'index.js', lang: 'javascript', isTest: false }, source, new Interner());
    assert.ok(ir.syntaxError, source);
  }
  const good = await parseFile({ rel: 'index.js', lang: 'javascript', isTest: false }, 'export const value = 1;\n', new Interner());
  assert.ok(!good.syntaxError);
});

test('una configuración inválida se conserva y detiene el análisis', async (t) => {
  const root = project(t, { 'index.js': 'const MIN_AGE = 18;\n' });
  const file = path.join(root, 'spectator.json');
  for (const source of ['{ broken json', 'null', '{"exclude":true}', '{"limits":{"duplicateTokens":0}}', '{"contract":[null]}', '{"contract":[{"name":"x"}]}']) {
    fs.writeFileSync(file, source);
    await assert.rejects(new Engine(root).scan(), /spectator.json/);
    assert.throws(() => updateConfig(root, (c) => { c.ignore = ['test']; }), /spectator.json/);
    assert.equal(fs.readFileSync(file, 'utf8'), source);
  }
});

test('una escritura fallida conserva el JSON anterior y limpia el temporal', (t) => {
  const root = project(t, { 'state.json': '{"original":true}' });
  const file = path.join(root, 'state.json');
  t.mock.method(fs, 'renameSync', () => { throw new Error('rename failed'); });
  assert.throws(() => writeJson(file, { replacement: true }), /rename failed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { original: true });
  assert.ok(!fs.readdirSync(root).some((f) => f.endsWith('.tmp')));
});

test('archivos grandes y límites producen un análisis parcial, nunca verificado', async (t) => {
  const root = project(t, { 'huge.js': 'function broken( {\n' + '// padding\n'.repeat(40000) });
  const engine = new Engine(root);
  let result = await engine.scan();
  assert.equal(result.stats.complete, false);
  assert.equal(result.verdict, 'risk');
  assert.ok(result.stats.skipped.some((s) => s.file === 'huge.js' && s.reason === 'size-limit'));
  assert.equal(fs.existsSync(path.join(root, '.spectator/baseline.json')), false);
  engine.ignoreFinding(result.findings.find((f) => f.rule === 'incomplete-analysis').fingerprint);
  result = await engine.scan();
  assert.notEqual(result.verdict, 'pass');
  await assert.rejects(engine.scan({ resetBaseline: true }), /incompleto/);
  fs.unlinkSync(path.join(root, 'huge.js'));
  fs.writeFileSync(path.join(root, 'a.js'), 'export const a = 1;\n');
  result = await engine.scan({ maxFiles: 1 });
  assert.equal(result.stats.truncated, true);
  assert.equal(result.stats.complete, false);
  await assert.rejects(engine.scan({ maxFiles: -1 }), /maxFiles/);
});

test('el código minificado omitido se informa incluso al reutilizar la caché', async (t) => {
  const root = project(t, { 'index.js': 'const value = 1;'.repeat(100) });
  const engine = new Engine(root);
  for (let i = 0; i < 2; i++) {
    const result = await engine.scan();
    assert.equal(result.stats.complete, false);
    assert.ok(result.stats.skipped.some((s) => s.reason === 'minified'));
  }
});

test('excluir un archivo no elimina su API; borrarlo realmente sí', async (t) => {
  const root = project(t, { 'index.js': 'export function hello() { return 1; }\n' });
  const engine = new Engine(root);
  await engine.scan();
  writeJson(path.join(root, 'spectator.json'), { exclude: ['index.js'] });
  let result = await engine.scan();
  assert.ok(!result.findings.some((f) => f.rule === 'removed-export'));
  assert.equal(result.delta.comparable, false);
  assert.equal(result.delta.fixed, 0);
  writeJson(path.join(root, 'spectator.json'), {});
  fs.unlinkSync(path.join(root, 'index.js'));
  result = await engine.scan();
  assert.ok(result.findings.some((f) => f.rule === 'removed-export'));
});

test('vaciar un archivo sí elimina su API pública', async (t) => {
  const root = project(t, { 'index.js': 'export function hello() { return 1; }\n' });
  const engine = new Engine(root);
  await engine.scan();
  fs.writeFileSync(path.join(root, 'index.js'), '');
  const result = await engine.scan();
  assert.ok(result.findings.some((f) => f.rule === 'removed-export'));
});

test('las normas distinguen números, booleanos y cadenas', async (t) => {
  const root = project(t, {
    'index.js': 'const MIN_AGE = "18";\nconst ALLOW_ACCESS = "true";\n',
    'spectator.json': JSON.stringify({ contract: [{ name: 'MIN_AGE', value: 18 }, { name: 'ALLOW_ACCESS', value: true }] }),
  });
  const result = await new Engine(root).scan();
  assert.equal(result.findings.filter((f) => f.rule === 'contract-conflict').length, 2);
  assert.match(result.findings.find((f) => f.symbol === 'MIN_AGE').tech, /"18"/);
});

test('las huellas de duplicación sobreviven a un reinicio y archivos ajenos nuevos', async (t) => {
  const body = Array.from({ length: 12 }, (_, i) => `  total += values[${i}] * ${i + 1};`).join('\n');
  const source = `function calc(values) {\n let total = 0;\n${body}\n return total;\n}\n`;
  const root = project(t, { 'b.js': source, 'c.js': source });
  const engine = new Engine(root);
  const first = await engine.scan();
  const unchanged = await engine.scan();
  assert.equal(unchanged.stats.duplicationCacheHit, true);
  assert.deepEqual(unchanged.findings, first.findings);
  fs.writeFileSync(path.join(root, 'a.js'), 'const alphabet = new Set(["unique"]);\n');
  const warm = await engine.scan();
  const cold = await new Engine(root).scan();
  const clones = (r) => r.findings.filter((f) => f.rule === 'clone').map((f) => f.fingerprint);
  assert.ok(clones(first).length);
  assert.deepEqual(clones(warm), clones(first));
  assert.deepEqual(clones(cold), clones(first));
  assert.equal(cold.delta.added, 0);
  assert.equal(cold.delta.fixed, 0);
  writeJson(path.join(root, 'spectator.json'), { limits: { duplicateTokens: 1000 } });
  const configured = await engine.scan();
  assert.equal(configured.stats.duplicationCacheHit, false);
  assert.deepEqual(clones(configured), []);
  fs.writeFileSync(path.join(root, 'c.js'), 'export const changed = true;\n');
  writeJson(path.join(root, 'spectator.json'), {});
  const changed = await engine.scan();
  assert.equal(changed.stats.duplicationCacheHit, false);
  assert.deepEqual(clones(changed), []);
});

test('gitleaks solo indica éxito con salida correcta e informe válido', async (t) => {
  const root = project(t, {});
  const childProcess = require('child_process');
  let scenario;
  t.mock.method(childProcess, 'execFile', (cmd, args, options, callback) => {
    if (cmd !== 'gitleaks') return callback(Object.assign(new Error('missing'), { code: 'ENOENT' }), '', '');
    const file = args[args.indexOf('--report-path') + 1];
    if (scenario.report !== undefined) fs.writeFileSync(file, scenario.report);
    callback(scenario.failed ? new Error('failed') : null, '', '');
  });
  const mod = require.resolve('../src/core/adapters');
  delete require.cache[mod];
  t.after(() => { delete require.cache[mod]; });
  const { runAdapters } = require('../src/core/adapters');
  for (scenario of [{ failed: true }, { report: 'invalid' }, { report: 'null' }, { report: '[null]' }, { failed: true, report: '[]' }, { report: '[]' }]) {
    const result = await runAdapters(root, []);
    assert.equal(result.tools.find((tool) => tool.name === 'gitleaks').ok, !scenario.failed && scenario.report === '[]');
  }
});
