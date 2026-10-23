'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../src/core');
const { globToRegex } = require('../src/core/util');
const { findCycles } = require('../src/core/graph');

function copy(name) {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-test-'));
  fs.cpSync(path.join(__dirname, '..', name), dst, { recursive: true, filter: (s) => !s.includes('.spectator') });
  return dst;
}
const rules = (r, cat) => r.findings.filter((f) => !cat || f.category === cat).map((f) => f.rule);

test('glob', () => {
  assert.ok(globToRegex('src/**/*.js').test('src/a/b/c.js'));
  assert.ok(globToRegex('src/**').test('src/a.js'));
  assert.ok(!globToRegex('src/*.js').test('src/a/b.js'));
});

test('ciclos', () => {
  const edges = new Map([['a', new Set(['b'])], ['b', new Set(['c'])], ['c', new Set(['a'])], ['d', new Set(['a'])]]);
  const c = findCycles(edges);
  assert.strictEqual(c.length, 1);
  assert.deepStrictEqual([...c[0]].sort(), ['a', 'b', 'c']);
});

test('demo restaurante: detecta cada problema plantado', async () => {
  const root = copy('examples/restaurante');
  const r = await new Engine(root).scan();
  const all = rules(r);
  for (const rule of ['unreachable', 'self-compare', 'missing-import', 'empty-catch', 'secret:db-url-password', 'sql-concat', 'eval', 'clone',
    'complex-function', 'unused-function', 'cycle', 'layer-skip', 'undeclared', 'unpinned', 'no-lockfile', 'unused', 'no-assert',
    'query-in-loop', 'await-in-loop', 'contract-conflict', 'inconsistent', 'no-readme', 'todo']) {
    assert.ok(all.includes(rule), 'falta la regla ' + rule);
  }
  assert.strictEqual(r.verdict, 'fail');
  assert.strictEqual(r.delta.added, 0, 'el primer análisis fija el punto de partida');
  const age = r.statements.find((s) => s.name === 'MIN_AGE');
  assert.strictEqual(age.status, 'conflict');
  assert.strictEqual(r.statements.find((s) => s.name === 'MAX_LOGIN_ATTEMPTS').status, 'ok');
  assert.ok(r.graph.callEdges.length > 10);
  // El secreto nunca sale en claro.
  assert.ok(!JSON.stringify(r).includes('Sup3rS3cret0'));
});

test('delta, compatibilidad, confirmar e ignorar', async () => {
  const root = copy('examples/restaurante');
  const engine = new Engine(root);
  const first = await engine.scan();
  const file = path.join(root, 'src/services/userService.js');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('function checkPassword(password) {', 'function checkPassword(password, extra) {\n  if (password == password) return eval(extra);')
    .replace(', isAdult,', ','));
  const second = await engine.scan();
  assert.ok(second.stats.cacheHits >= first.stats.files - 1, 'solo se vuelve a leer el archivo cambiado');
  const fresh = second.findings.filter((f) => f.isNew).map((f) => f.rule);
  assert.ok(fresh.includes('self-compare') && fresh.includes('eval') && fresh.includes('removed-export') && fresh.includes('signature-change'), fresh.join());
  assert.strictEqual(second.delta.added, fresh.length);

  engine.confirmStatement(second.statements.find((s) => s.name === 'SESSION_TIMEOUT_MINUTES'));
  engine.ignoreFinding(second.findings.find((f) => f.rule === 'eval' && f.isNew).fingerprint);
  const third = await engine.scan();
  assert.strictEqual(third.statements.find((s) => s.name === 'SESSION_TIMEOUT_MINUTES').status, 'ok');
  assert.strictEqual(third.stats.ignored, 1);
  fs.writeFileSync(path.join(root, 'src/config.js'), fs.readFileSync(path.join(root, 'src/config.js'), 'utf8').replace('SESSION_TIMEOUT_MINUTES = 30', 'SESSION_TIMEOUT_MINUTES = 90'));
  const fourth = await engine.scan();
  assert.strictEqual(fourth.statements.find((s) => s.name === 'SESSION_TIMEOUT_MINUTES').status, 'conflict', 'cambiar una norma confirmada es un conflicto');
});

test('políglota: el mismo modelo para 11 lenguajes y scripts incrustados', async () => {
  const root = copy('test/fixtures/poliglota');
  const r = await new Engine(root).scan();
  const langs = Object.keys(r.stats.languages).sort();
  assert.deepStrictEqual(langs, ['c_sharp', 'go', 'java', 'kotlin', 'php', 'python', 'ruby', 'rust', 'swift', 'tsx', 'typescript']);
  assert.strictEqual(r.stats.unparsed, 0);
  const names = new Set(r.graph.units.map((u) => u.name));
  for (const n of ['register', 'save_user', 'run', 'helper', 'Process', 'compute', 'double', 'add', 'store', 'total', 'price', 'Handle', 'Compute', 'View', 'orphan', 'sync', 'save2', 'refresh', 'increment', 'init']) assert.ok(names.has(n), 'no se extrajo la función ' + n);
  const edge = (a, b) => r.graph.callEdges.some(([x, y]) => r.graph.units[x].name === a && r.graph.units[y].name === b);
  for (const [a, b] of [['register', 'save_user'], ['run', 'helper'], ['compute', 'double'], ['add', 'store'], ['total', 'price'], ['Handle', 'Compute'], ['View', 'helper'], ['main', 'Process'], ['sync', 'save2'], ['increment', 'helper']]) assert.ok(edge(a, b), `falta la llamada ${a} → ${b}`);
  const fileEdge = (a, b) => r.graph.fileEdges.some(([x, y]) => r.graph.files[x].rel.endsWith(a) && r.graph.files[y].rel.endsWith(b));
  for (const [a, b] of [['users.py', 'db.py'], ['lib.rs', 'util.rs'], ['order.rb', 'helper.rb'], ['view.tsx', 'helper.ts'], ['test_users.py', 'users.py'], ['NoteView.swift', 'NoteStore.swift'], ['Widget.vue', 'helper.ts']]) assert.ok(fileEdge(a, b), `falta el import ${a} → ${b}`);
  const all = rules(r);
  for (const rule of ['unreachable', 'mutable-default', 'empty-catch', 'pickle', 'unused-function']) assert.ok(all.includes(rule), 'falta ' + rule);
  const st = r.statements.map((s) => `${s.name} ${s.op} ${s.value}`);
  for (const s of ['MIN_AGE = 18', 'age >= 21', 'password.length >= 8', 'MAX_RETRIES = 3', 'MaxItems = 50', 'MAX_ITEMS = 20', 'MAX_TOTAL = 500', 'age >= 18', 'MAX_NOTES = 50', 'MAX_ITEMS = 30', 'MAX_CLICKS = 10']) assert.ok(st.includes(s), `falta el statement «${s}» en: ${st.join(' | ')}`);
  assert.ok(!r.findings.some((f) => f.rule === 'syntax-error'), 'no debe haber falsos errores de sintaxis');
  const at = (rule, file) => r.findings.some((f) => f.rule === rule && f.file.endsWith(file));
  assert.ok(at('unreachable', 'NoteStore.swift') && at('empty-catch', 'NoteStore.swift') && at('empty-catch', 'Cart.kt'), 'Swift y Kotlin comparten los mismos detectores');
  assert.ok(!at('unused-function', 'Widget.vue'), 'un manejador usado en la plantilla no es código sin usar');
  assert.ok(!r.graph.fileEdges.some(([a, b]) => r.graph.files[a].rel.endsWith('.vue') && r.graph.files[b].rel.endsWith('.rb')), 'los imports no cruzan lenguajes');
});

test('flujo en vivo: cuenta las funciones realmente ejecutadas', async () => {
  const root = copy('examples/restaurante');
  fs.writeFileSync(path.join(root, 'run.js'), "const { checkAge, checkPassword } = require('./src/services/userService');\nfor (let i = 0; i < 5; i++) checkAge({ age: 30 });\ncheckPassword('abcdefgh');\n");
  const engine = new Engine(root);
  await engine.scan();
  const data = await new Promise((resolve) => engine.trace('node run.js', { onExit: resolve }));
  assert.strictEqual(data.exitCode, 0);
  assert.strictEqual(data.evidence, 'function-coverage');
  assert.strictEqual(data.observedCalls, false);
  assert.strictEqual(data.counts['src/services/userService.js#checkAge'], 5);
  assert.strictEqual(data.counts['src/services/userService.js#checkPassword'], 1);
  assert.ok(!('src/services/userService.js#register' in data.counts));
});
