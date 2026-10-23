'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('Flow nunca convierte dos contadores positivos en una llamada observada', () => {
  const strokes = [], text = [], frames = new Map();
  let frameId = 0, message, particles = 0, pathKind;
  const ctx = new Proxy({
    beginPath() { pathKind = null; },
    bezierCurveTo() { pathKind = 'edge'; },
    roundRect() { pathKind = 'node'; },
    stroke() { if (pathKind === 'edge') strokes.push(this.strokeStyle); },
    arc() { particles++; },
    measureText(value) { return { width: value.length * 6 }; },
    fillText(value) { text.push(value); },
  }, { get: (object, key) => key in object ? object[key] : () => {} });
  class Element {
    constructor(tag) { this.tag = tag; this.nodeType = 1; this.children = []; this.attrs = {}; this.events = {}; this.style = {}; }
    append(...children) { this.children.push(...children); }
    set textContent(value) { this.children = value ? [String(value)] : []; }
    get textContent() { return this.children.map((child) => child.textContent ?? child).join(''); }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(key, callback) { this.events[key] = callback; }
    getContext() { return ctx; }
    getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 1000, height: 700 }; }
    querySelector() { return null; }
  }
  const root = new Element('div');
  const data = {
    name: 'fixture', verdict: 'pass', findings: [], statements: [],
    graph: {
      files: [{ rel: 'a.js', lines: 1 }, { rel: 'b.js', lines: 1 }], fileEdges: [[0, 1]],
      units: [{ id: 'a.js#first', name: 'first', f: 0 }, { id: 'b.js#second', name: 'second', f: 1 }], callEdges: [[0, 1]],
    },
    // Los informes anteriores no tienen metadatos de evidencia. También deben ser seguros.
    runtime: { command: 'node run.js', counts: { 'a.js#first': 1, 'b.js#second': 1 } },
  };
  const window = {
    __PG_DATA__: data, __PG_LOCALE__: 'es', devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }),
    addEventListener: (name, callback) => { if (name === 'message') message = callback; },
  };
  const sandbox = {
    window, document: { documentElement: {}, body: {}, getElementById: () => root, createElement: (tag) => new Element(tag),
      createElementNS: (_, tag) => new Element(tag), createTextNode: (value) => ({ nodeType: 3, textContent: String(value) }) },
    acquireVsCodeApi: () => ({ getState: () => ({ tab: 'flow' }), setState() {}, postMessage() {} }),
    getComputedStyle: () => ({ getPropertyValue: (key) => key, fontFamily: 'sans-serif' }),
    requestAnimationFrame: (callback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id) => frames.delete(id),
    ResizeObserver: class { constructor(callback) { this.callback = callback; } observe() { this.callback(); } disconnect() {} },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/app.js'), 'utf8'), sandbox);
  const draw = (time) => {
    strokes.length = 0;
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(time);
    assert.ok(strokes.length, 'se dibuja la conexión estática');
    assert.ok(strokes.every((color) => color === '--muted'), 'la conexión no recibe el color de ejecución');
    assert.equal(particles, 0, 'no hay partículas que simulen llamadas');
  };
  draw(16);
  const find = (node, predicate) => predicate(node) ? node : (node.children || []).map((child) => find(child, predicate)).find(Boolean);
  find(root, (node) => node.tag === 'button' && node.textContent === 'Funciones').events.click();
  draw(32);
  message({ data: { type: 'trace', delta: { 'a.js#first': 1, 'b.js#second': 1 }, totals: { 'a.js#first': 2, 'b.js#second': 2 } } });
  draw(48);
  assert.ok(text.includes('×2'), 'la actividad de las funciones sí se actualiza');
  assert.match(root.textContent, /no llamadas entre ellas/);
});
