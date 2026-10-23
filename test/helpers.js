'use strict';
// Utilidades compartidas por las pruebas de regresión: proyectos temporales, un DOM mínimo para la interfaz
// y un doble de la API de VS Code que admite varias carpetas.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

function project(t, files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spectator-e0-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries({ 'README.md': 'Fixture', ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  return root;
}

/** Carga media/app.js con los datos de un análisis y devuelve cómo consultarla y manejarla. */
function ui(data, state = {}) {
  const ctx = new Proxy({ measureText: (v) => ({ width: String(v).length * 6 }) }, { get: (o, k) => (k in o ? o[k] : () => {}) });
  class Element {
    constructor(tag) { this.tag = tag; this.nodeType = 1; this.children = []; this.attrs = {}; this.events = {}; this.style = {}; }
    append(...kids) { this.children.push(...kids); }
    set textContent(v) { this.children = v ? [String(v)] : []; }
    get textContent() { return this.children.map((c) => c.textContent ?? c).join(''); }
    set className(v) { this.attrs.class = v; }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener(k, fn) { this.events[k] = fn; }
    getContext() { return ctx; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 700 }; }
    querySelector() { return null; }
  }
  const root = new Element('div');
  const posted = [];
  let message;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'media/app.js'), 'utf8'), {
    window: { __PG_DATA__: data, __PG_LOCALE__: 'es', devicePixelRatio: 1, matchMedia: () => ({ matches: false }), addEventListener(name, cb) { if (name === 'message') message = cb; } },
    document: { documentElement: {}, body: {}, getElementById: () => root, createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag), createTextNode: (v) => ({ nodeType: 3, textContent: String(v) }) },
    acquireVsCodeApi: () => ({ getState: () => state, setState() {}, postMessage: (m) => posted.push(m) }),
    getComputedStyle: () => ({ getPropertyValue: (k) => k, fontFamily: 'sans-serif' }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    ResizeObserver: class { constructor(cb) { this.cb = cb; } observe() { this.cb(); } disconnect() {} },
  });
  const all = (pred, node = root, out = []) => { if (pred(node)) out.push(node); for (const c of node.children || []) all(pred, c, out); return out; };
  return {
    posted, all,
    text: () => root.textContent,
    button: (label) => all((n) => n.tag === 'button' && n.textContent.startsWith(label))[0],
    scope: (value) => all((n) => n.tag === 'select')[0].events.change({ target: { value } }),
    send: (m) => message({ data: m }),
  };
}

function fakeVscode(roots) {
  const state = { commands: {}, diagnostics: new Map(), posted: [], warnings: [], errors: [], onSave: null, onMessage: null, tree: null, status: {}, opened: null };
  class Emitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
  class Range { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } }
  const Uri = { file: (p) => ({ fsPath: p, toString: () => p }), joinPath: (u, ...p) => Uri.file(path.join(u.fsPath, ...p)) };
  // Vigilante de archivos: las pruebas simulan cambios hechos desde otro editor llamando a state.fsw.change(ruta).
  const listeners = { create: [], change: [], delete: [] };
  state.fsw = { create: (p) => listeners.create.forEach((f) => f(Uri.file(p))), change: (p) => listeners.change.forEach((f) => f(Uri.file(p))), remove: (p) => listeners.delete.forEach((f) => f(Uri.file(p))) };
  return {
    state, Uri, Range, RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } }, EventEmitter: Emitter, env: { language: 'es' },
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class { constructor(id) { this.id = id; } }, ThemeColor: class { constructor(id) { this.id = id; } },
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 }, StatusBarAlignment: { Left: 1 }, ViewColumn: { Active: -1, Beside: -2 }, ProgressLocation: { Window: 10 },
    workspace: {
      workspaceFolders: roots.map((r) => ({ uri: Uri.file(r), name: path.basename(r) })),
      getConfiguration: () => ({ get: (k) => ({ scanOnSave: true, diagnostics: true, maxFiles: 5000 })[k] }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      onDidSaveTextDocument: (fn) => { state.onSave = fn; return { dispose() {} }; },
      openTextDocument: async (f) => ({ file: f }),
      createFileSystemWatcher: () => ({
        onDidCreate: (fn) => { listeners.create.push(fn); return { dispose() {} }; }, onDidChange: (fn) => { listeners.change.push(fn); return { dispose() {} }; },
        onDidDelete: (fn) => { listeners.delete.push(fn); return { dispose() {} }; }, dispose() {},
      }),
    },
    languages: { createDiagnosticCollection: () => ({ clear: () => state.diagnostics.clear(), set: (u, l) => state.diagnostics.set(u.fsPath, l), delete: (u) => state.diagnostics.delete(u.fsPath), forEach: (fn) => { for (const k of [...state.diagnostics.keys()]) fn(Uri.file(k)); }, dispose() {} }) },
    commands: { registerCommand: (id, fn) => { state.commands[id] = fn; return { dispose() {} }; } },
    window: {
      createStatusBarItem: () => Object.assign(state.status, { show() {}, dispose() {} }),
      registerTreeDataProvider: (id, tree) => { state.tree = tree; return { dispose() {} }; },
      withProgress: (o, fn) => fn(),
      showWarningMessage: async (m) => { state.warnings.push(m); }, showInformationMessage: async (m) => { (state.infos || (state.infos = [])).push(m); }, showErrorMessage: async (m) => { state.errors.push(m); },
      showTextDocument: async (doc, opts) => { state.opened = { doc, opts }; },
      createWebviewPanel: () => ({
        webview: { html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u.fsPath, postMessage: (m) => { state.posted.push(m); return true; }, onDidReceiveMessage: (fn) => { state.onMessage = fn; } },
        onDidDispose() {}, reveal() {},
      }),
    },
  };
}

/** Activa la extensión contra el doble de VS Code con las carpetas indicadas y espera su primer análisis. */
async function activate(t, roots) {
  const vscode = fakeVscode(roots);
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : load.call(this, request, ...rest); };
  const file = require.resolve('../src/extension');
  delete require.cache[file];
  let ext;
  try { ext = require(file); } finally { Module._load = load; }
  const ctx = { subscriptions: [], extensionUri: vscode.Uri.file(ROOT) };
  ext.activate(ctx);
  // Siempre se cierra el proceso del motor, también si falla una comprobación.
  t.after(() => { for (const d of ctx.subscriptions) d.dispose && d.dispose(); });
  const S = vscode.state;
  await until(() => S.status.text);
  S.commands['spectator.open']();
  await S.onMessage({ type: 'ready' });
  return { S, vscode };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (cond, ms = 8000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('tiempo agotado'); await sleep(25); } };

module.exports = { ROOT, project, ui, fakeVscode, activate, sleep, until };
