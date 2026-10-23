'use strict';
// Partes del proyecto: detección de componentes, avisos de flujo y navegación por alcance en la interfaz.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { Engine } = require('../src/core');

function project(t, files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spectator-parts-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const TWO_PARTS = {
  'web/package.json': '{"name":"tienda-web","version":"1.0.0"}',
  'web/src/cart.js': "import { total, missing } from './money';\nexport function checkout(items) { return total(items) + missing(items); }\n",
  'web/src/money.js': 'export function total(items) { return items.length; }\n',
  'api/requirements.txt': 'flask==3.0.0\n',
  'api/app/main.py': 'def handler(event):\n    return 1\n',
  'README.md': '# demo\n',
};

test('detecta las partes por su manifiesto y admite partes declaradas', async (t) => {
  const root = project(t, TWO_PARTS);
  let result = await new Engine(root).scan();
  assert.deepEqual(result.components.map((c) => [c.path, c.name, c.kind]), [['api', 'api', 'Python'], ['web', 'tienda-web', 'Node.js']]);
  fs.writeFileSync(path.join(root, 'spectator.json'), JSON.stringify({ components: [{ name: 'Núcleo', path: 'web/src/**' }, { name: 'No existe', path: 'nada' }] }));
  result = await new Engine(root).scan();
  assert.deepEqual(result.components.find((c) => c.path === 'web/src'), { path: 'web/src', name: 'Núcleo', kind: '', declared: true });
  assert.ok(!result.components.some((c) => c.path === 'nada'));
});

test('un nombre importado que el destino no exporta es una falla de flujo; lo dudoso no se afirma', async (t) => {
  const root = project(t, {
    ...TWO_PARTS,
    'web/src/star.js': "export * from './money';\n",
    'web/src/viaStar.js': "import { anything } from './star';\nexport const a = anything;\n",
    'web/src/cjs.js': 'module.exports = require("./money");\n',
    'web/src/viaCjs.js': "import { dynamic } from './cjs';\nexport const b = dynamic;\n",
    'web/src/shape.js': 'const box = { width: 1 };\nexport const { width } = box;\n',
    'web/src/viaShape.js': "import { width } from './shape';\nexport const c = width;\n",
  });
  const result = await new Engine(root).scan();
  const broken = result.findings.filter((f) => f.rule === 'broken-import');
  assert.deepEqual(broken.map((f) => [f.file, f.line, f.severity, f.flow]), [['web/src/cart.js', 1, 'fail', true]]);
  assert.match(broken[0].title, /missing/);
  const checkout = result.graph.units.find((u) => u.name === 'checkout');
  assert.equal(checkout.end, 2, 'las funciones llevan su línea final para situar avisos dentro de ellas');
});

test('en lenguajes sin imports por archivo, las pruebas alcanzan el código por los tipos que usan', async (t) => {
  const root = project(t, {
    'Sources/App/Store.swift': 'final class NoteStore {\n    func add() -> Bool { return true }\n}\n',
    'Tests/AppTests/StoreTests.swift': 'import XCTest\nfinal class StoreTests: XCTestCase {\n    func testAdd() { XCTAssertTrue(NoteStore().add()) }\n}\n',
  });
  const result = await new Engine(root).scan();
  assert.deepEqual(result.stats.tests, { testFiles: 1, sourceFiles: 1, covered: 1 });
});

test('excluir es una decisión explícita y solo admite archivos que el análisis omitió', async (t) => {
  const root = project(t, { 'a.js': 'export const a = 1;\n', 'bundle.js': 'const value = 1;'.repeat(100) });
  const engine = new Engine(root);
  let result = await engine.scan();
  assert.equal(result.stats.complete, false);
  assert.equal(engine.excludeFiles(['a.js', '../../etc/passwd']), 0, 'no excluye archivos que sí se analizan');
  assert.equal(engine.excludeFiles(['bundle.js']), 1);
  result = await engine.scan();
  assert.equal(result.stats.complete, true);
  assert.ok(fs.existsSync(path.join(root, '.spectator/baseline.json')), 'con el análisis completo ya se guarda el punto de partida');
});

test('la interfaz limita cada pestaña a la parte elegida y baja hasta las funciones', async (t) => {
  const root = project(t, TWO_PARTS);
  const data = JSON.parse(JSON.stringify(await new Engine(root).scan()));
  const ctx = new Proxy({ measureText: (v) => ({ width: String(v).length * 6 }) }, { get: (o, k) => (k in o ? o[k] : () => {}) });
  class Element {
    constructor(tag) { this.tag = tag; this.nodeType = 1; this.children = []; this.attrs = {}; this.events = {}; this.style = {}; }
    append(...kids) { for (const kid of kids) { assert.ok(kid != null && !Array.isArray(kid), 'append nunca recibe null ni listas'); this.children.push(kid); } }
    set textContent(v) { this.children = v ? [String(v)] : []; }
    get textContent() { return this.children.map((c) => c.textContent ?? c).join(''); }
    set className(v) { this.attrs.class = v; }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener(k, fn) { this.events[k] = fn; }
    getContext() { return ctx; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 700 }; }
    querySelector() { return null; }
  }
  const root_ = new Element('div');
  const posted = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/app.js'), 'utf8'), {
    window: { __PG_DATA__: data, __PG_LOCALE__: 'es', devicePixelRatio: 1, matchMedia: () => ({ matches: false }), addEventListener() {} },
    document: { documentElement: {}, body: {}, getElementById: () => root_, createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag), createTextNode: (v) => ({ nodeType: 3, textContent: String(v) }) },
    acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage: (m) => posted.push(m) }),
    getComputedStyle: () => ({ getPropertyValue: (k) => k, fontFamily: 'sans-serif' }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    ResizeObserver: class { constructor(cb) { this.cb = cb; } observe() { this.cb(); } disconnect() {} },
  });
  const all = (node, pred, out = []) => { if (pred(node)) out.push(node); for (const c of node.children || []) all(c, pred, out); return out; };
  const button = (text) => all(root_, (n) => n.tag === 'button' && n.textContent.startsWith(text))[0];
  const cls = (name) => all(root_, (n) => (n.attrs?.class || '').split(' ').includes(name));

  // Proyecto entero: las dos partes aparecen como tarjetas, cada una con su estado.
  const cards = cls('part').map((n) => n.textContent);
  assert.equal(cards.length, 2);
  assert.ok(cards[0].startsWith('apiPython') && cards[1].startsWith('tienda-webNode.js'), cards.join(' | '));
  assert.match(cards[1], /1 falla\b/, 'singular correcto');
  const options = all(root_, (n) => n.tag === 'option').map((n) => n.textContent.trim());
  assert.deepEqual(options, ['Proyecto entero', 'api · Python', 'tienda-web · Node.js']);
  assert.match(button('Problemas').textContent, /\d/);

  // Entrar en «web»: solo cuentan sus avisos y aparecen las migas.
  all(root_, (n) => n.tag === 'select')[0].events.change({ target: { value: 'web' } });
  assert.match(cls('crumbs')[0].textContent, /web/);
  assert.match(root_.textContent, /«tienda-web» tiene 1 falla demostrada/);
  button('Mapa').events.click();
  button('Código').events.click();
  assert.equal(all(root_, (n) => n.tag === 'canvas').length, 1);
  button('Funciones').events.click();
  assert.equal(button('Funciones').attrs['aria-pressed'], 'true');
  // En la otra parte no hay nada roto.
  all(root_, (n) => n.tag === 'select')[0].events.change({ target: { value: 'api' } });
  button('Resumen').events.click();
  assert.doesNotMatch(root_.textContent, /falla demostrada/);
  assert.doesNotMatch(root_.textContent, /\[object |null|undefined/);
});
