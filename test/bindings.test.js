'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFile, Interner } = require('../src/core/parse');
const { buildGraph } = require('../src/core/graph');

async function graph(sources) {
  const irs = [], interner = new Interner();
  for (const [rel, source] of Object.entries(sources)) {
    const lang = rel.endsWith('.py') ? 'python' : rel.endsWith('.java') ? 'java' : rel.endsWith('.cs') ? 'c_sharp' : 'typescript';
    const ir = await parseFile({ rel, lang, isTest: false }, source, interner);
    assert.equal(ir.parsed, true, ir.parseError);
    irs.push(ir);
  }
  return buildGraph('/tmp', irs);
}
const has = (g, a, b) => g.callEdges.some(([from, to]) => from === a && to === b);

test('Java y C# distinguen métodos homónimos de clases diferentes', async () => {
  for (const extension of ['java','cs']) {
    const rel = 'main.' + extension;
    const g = await graph({ [rel]: 'class A { void Save() {} void Run() { this.Save(); } } class B { void Save() {} void Run() { this.Save(); } }' });
    assert.ok(has(g,rel+'#A.Run',rel+'#A.Save'));
    assert.ok(has(g,rel+'#B.Run',rel+'#B.Save'));
    assert.ok(!has(g,rel+'#A.Run',rel+'#B.Save'));
  }
});

test('herencia importada: métodos heredados, overrides, super y dispatch posible de this', async () => {
  const g = await graph({
    'base.ts': 'export class Base { save() {} run() { this.save(); } static build() {} }',
    'child.ts': "import {Base} from './base'; class Child extends Base { save() {} run() { super.run(); } } const child = new Child(); function main() { child.run(); Child.build(); }",
  });
  for (const [a, b] of [['child.ts#Child.run','base.ts#Base.run'],['child.ts#main','base.ts#Base.build'],['base.ts#Base.run','base.ts#Base.save'],['base.ts#Base.run','child.ts#Child.save']]) assert.ok(has(g,a,b), a+' -> '+b);
});

test('claves constantes, call, apply y bind conservan el destino sin ejecutar bind', async () => {
  const g = await graph({ 'main.ts': `function save() {} const handlers = { save }; const key = 'save';
const bound = save.bind(null);
function run() { handlers[key](); save.call(null); save.apply(null, []); bound(); }
function unknown(key) { handlers[key](); }` });
  assert.equal(g.callEdges.filter(([a,b]) => a==='main.ts#run' && b==='main.ts#save').length, 4);
  assert.ok(!has(g,'main.ts#<módulo>','main.ts#save'));
  assert.ok(!has(g,'main.ts#unknown','main.ts#save'));
});

test('Python: alias, módulos, ámbitos, herencia simple y getattr con clave constante', async () => {
  const g = await graph({
    'repo.py': 'def save():\n pass\nclass Base:\n def store(self):\n  pass\n',
    'main.py': `from repo import save as persist, Base\nimport repo as db\nclass Child(Base):\n def run(self):\n  super().store()\n  self.store()\ndef run():\n persist()\n db.save()\n child = Child()\n getattr(child, "store")()\ndef blocked(persist, db):\n persist()\n db.save()\n`,
  });
  assert.ok(has(g,'main.py#run','repo.py#save'));
  assert.ok(has(g,'main.py#Child.run','repo.py#Base.store'));
  assert.ok(has(g,'main.py#run','repo.py#Base.store'));
  assert.ok(!g.callEdges.some(([a])=>a==='main.py#blocked'));
});

test('resuelve alias ESM y namespaces sin confundir funciones homónimas', async () => {
  const g = await graph({
    'a.ts': 'export function save() {}',
    'b.ts': 'export function save() {}',
    'main.ts': `import { save as persist } from './a'; import * as other from './b';
function save() {}
function run() { persist(); other.save(); }
function blocked(persist, other) { persist(); other.save(); }`,
  });
  assert.ok(has(g, 'main.ts#run', 'a.ts#save'));
  assert.ok(has(g, 'main.ts#run', 'b.ts#save'));
  assert.ok(!has(g, 'main.ts#run', 'main.ts#save'));
  assert.ok(!g.callEdges.some(([from]) => from === 'main.ts#blocked'));
});

test('respeta ámbitos anidados, bloques, parámetros y reasignaciones', async () => {
  const g = await graph({ 'main.ts': `function helper() {}
function outer() {
  function helper() {}
  helper();
}
function sibling() { helper(); }
function blocked(helper) { helper(); }
function block() { { const helper = unknown; helper(); } helper(); }
let changing = helper; changing = external;
function changed() { changing(); }` });
  const helpers = g.byRel.get('main.ts').units.filter((u) => u.name === 'helper');
  assert.ok(has(g, 'main.ts#outer', helpers[1].id));
  assert.ok(!has(g, 'main.ts#outer', helpers[0].id));
  assert.ok(has(g, 'main.ts#sibling', helpers[0].id));
  assert.equal(g.callEdges.filter(([from]) => from === 'main.ts#block').length, 1);
  assert.ok(!g.callEdges.some(([from]) => from === 'main.ts#blocked' || from === 'main.ts#changed'));
});

test('resuelve métodos por receptor e instancia sin elegir otra clase', async () => {
  const g = await graph({ 'main.ts': `class A { save() {} run() { this.save(); } static build() {} }
class B { save() {} run() { this.save(); } }
const a = new A();
function run() { a.save(); A.build(); }
function blocked(a) { a.save(); }` });
  for (const [a, b] of [['A.run', 'A.save'], ['B.run', 'B.save'], ['run', 'A.save'], ['run', 'A.build']]) assert.ok(has(g, 'main.ts#' + a, 'main.ts#' + b), a + ' -> ' + b);
  assert.ok(!has(g, 'main.ts#A.run', 'main.ts#B.save'));
  assert.ok(!g.callEdges.some(([from]) => from === 'main.ts#blocked'));
});

test('resuelve CommonJS, exportaciones renombradas y reexportaciones explícitas', async () => {
  const g = await graph({
    'repo.ts': 'function save() {} module.exports = { persist: save };',
    'barrel.ts': "export {persist as write} from './repo';",
    'default.ts': 'export default function work() {}',
    'main.ts': `const { persist: commit } = require('./repo');
const db = require('./repo');
import {write} from './barrel'; import job from './default';
function run() { commit(); db.persist(); write(); job(); }`,
  });
  assert.equal(g.callEdges.filter(([a, b]) => a === 'main.ts#run' && b === 'repo.ts#save').length, 3);
  assert.ok(has(g, 'main.ts#run', 'default.ts#work'));
});

test('resuelve clases importadas y conserva llamadas recursivas', async () => {
  const g = await graph({
    'repo.ts': 'export class Repo { save() {} }',
    'main.ts': "import {Repo as Store} from './repo'; const repo = new Store(); function run() { repo.save(); } function recur() { recur(); }",
  });
  assert.ok(has(g, 'main.ts#run', 'repo.ts#Repo.save'));
  assert.ok(has(g, 'main.ts#recur', 'main.ts#recur'));
});

test('no inventa conexiones con funciones únicas no importadas, externas o de otro lenguaje', async () => {
  const g = await graph({
    'unused.ts': 'export function purchase() {}',
    'python.py': 'def execute_order():\n    return 1\n',
    'main.ts': "import {purchase} from 'external-package'; function run() { purchase(); execute_order(); missing.purchase(); }",
  });
  assert.equal(g.callEdges.length, 0);
  assert.equal(g.unresolvedCalls.length, 3);
});

test('los callbacks anónimos no se atribuyen al llamador exterior', async () => {
  const g = await graph({ 'main.ts': 'function task() {} function start() { queue(() => task()); }' });
  assert.ok(!has(g, 'main.ts#start', 'main.ts#task'));
});

test('el orden de los archivos no cambia las conexiones', async () => {
  const sources = {
    'a.ts': 'export function save() {}',
    'b.ts': 'export function save() {}',
    'main.ts': "import * as a from './a'; import * as b from './b'; function run() { a.save(); b.save(); }",
  };
  const first = await graph(sources);
  const second = await graph(Object.fromEntries(Object.entries(sources).reverse()));
  assert.deepEqual(first.callEdges.sort(), second.callEdges.sort());
});

test('un alias de ruta ambiguo no elige arbitrariamente un módulo', async () => {
  const g = await graph({
    'src/repo.ts': 'export function save() {}',
    'other/src/repo.ts': 'export function save() {}',
    'main.ts': "import {save} from '@/src/repo'; function run() { save(); }",
  });
  assert.equal(g.callEdges.length, 0);
  assert.equal(g.importEdges.get('main.ts').size, 0);
  assert.equal(g.unresolvedCalls.length, 1);
});

test('los bindings de for-of y catch ocultan funciones exteriores', async () => {
  const g = await graph({ 'main.ts': 'function save() {} function run({ save = external }) { for (const save of values) save(); try {} catch(save) { save(); } save(); }' });
  assert.ok(!has(g, 'main.ts#run', 'main.ts#save'));
});

test('las reasignaciones desestructuradas invalidan los alias de función', async () => {
  const g = await graph({ 'main.ts': 'function target() {} let save = target; ({ save } = external); function run() { save(); }' });
  assert.ok(!has(g, 'main.ts#run', 'main.ts#target'));
});

test('no confunde getters, propiedades reasignadas ni exports locales con métodos públicos', async () => {
  const g = await graph({
    'local.ts': 'const exports = {}; function save() {} exports.save = save;',
    'main.ts': "const local = require('./local'); class A { get task() { return external; } save() {} } const a = new A(); const b = a; b.save = external; function run() { a.task(); a.save(); local.save(); }",
  });
  assert.ok(!g.callEdges.some(([from]) => from === 'main.ts#run'));
});

test('propiedades de clase y diccionarios modificados no conservan métodos obsoletos', async () => {
  const js = await graph({ 'main.ts': 'class Base { save() {} } class Child extends Base { save = external; } const child = new Child(); function run() { child.save(); }' });
  assert.ok(!has(js, 'main.ts#run', 'main.ts#Base.save'));
  const py = await graph({ 'main.py': 'def save():\n pass\nclass Base:\n def store(self):\n  pass\nclass Child(Base):\n store = external\nhandlers = {"save": save}\nhandlers["save"] = external\ndef run():\n Child().store()\n handlers["save"]()\n' });
  assert.ok(!py.callEdges.some(([from]) => from === 'main.py#run'));
});

test('super constructor y métodos estáticos incluyen overrides posibles', async () => {
  const g = await graph({ 'main.ts': 'class Base { constructor() {} static save() {} static run() { this.save(); } } class Child extends Base { constructor() { super(); } static save() {} }' });
  assert.ok(has(g, 'main.ts#Child.constructor', 'main.ts#Base.constructor'));
  assert.ok(has(g, 'main.ts#Base.run', 'main.ts#Base.save'));
  assert.ok(has(g, 'main.ts#Base.run', 'main.ts#Child.save'));
});

test('exportaciones estrella: cadenas, namespaces, ciclos y ambigüedad', async () => {
  const sources = {
    'lib.ts': 'export function save() {} export default function hidden() {}',
    'other.ts': 'export function save() {}',
    'barrel.ts': "export * from './lib'; export * from './cycle'; export * as api from './lib';",
    'cycle.ts': "export * from './barrel';",
    'ambiguous.ts': "export * from './lib'; export * from './other';",
    'main.ts': "import {save, api} from './barrel'; import hidden from './barrel'; import {save as blocked} from './ambiguous'; function run() { save(); api.save(); } function unknown() { hidden(); blocked(); }",
  };
  const g = await graph(sources);
  assert.equal(g.callEdges.filter(([a,b]) => a === 'main.ts#run' && b === 'lib.ts#save').length, 2);
  assert.ok(!g.callEdges.some(([from]) => from === 'main.ts#unknown'));
});

test('no conserva destinos después de escrituras calculadas o delete', async () => {
  for (const mutation of ['const key = "save"; obj[key] = external;', 'delete obj.save;']) {
    const g = await graph({ 'main.ts': 'function save() {} const obj = { save }; ' + mutation + ' function run() { obj.save(); }' });
    assert.ok(!has(g, 'main.ts#run', 'main.ts#save'));
  }
});

test('Python: los alias de except y with ocultan funciones exteriores', async () => {
  const g = await graph({ 'main.py': 'def target():\n pass\ndef run():\n try:\n  pass\n except Error as target:\n  target()\ndef work():\n with resource() as target:\n  target()\n' });
  assert.ok(!g.callEdges.some(([,to]) => to === 'main.py#target'));
});
