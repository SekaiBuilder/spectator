'use strict';
// Activa la extensión contra un doble mínimo de la API de VS Code para comprobar el cableado
// (comandos, árbol, diagnósticos y mensajes del panel) sin abrir el editor.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function fakeVscode(root) {
  const state = { commands: {}, diagnostics: new Map(), posted: [], warnings: [], onSave: null, onMessage: null, tree: null, status: {} };
  class Emitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
  class Range { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } }
  const Uri = { file: (p) => ({ fsPath: p, toString: () => p }), joinPath: (u, ...p) => Uri.file(path.join(u.fsPath, ...p)) };
  const api = {
    state, Uri, Range, EventEmitter: Emitter, env: { language: 'es' },
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class { constructor(id) { this.id = id; } }, ThemeColor: class { constructor(id) { this.id = id; } },
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 }, StatusBarAlignment: { Left: 1 }, ViewColumn: { Active: -1, Beside: -2 }, ProgressLocation: { Window: 10 },
    workspace: {
      workspaceFolders: [{ uri: Uri.file(root) }],
      getConfiguration: () => ({ get: (k) => ({ scanOnSave: true, diagnostics: true, maxFiles: 5000 })[k] }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      onDidSaveTextDocument: (fn) => { state.onSave = fn; return { dispose() {} }; },
      openTextDocument: async (f) => ({ file: f }),
    },
    languages: { createDiagnosticCollection: () => ({ clear: () => state.diagnostics.clear(), set: (u, l) => state.diagnostics.set(u.fsPath, l), dispose() {} }) },
    commands: { registerCommand: (id, fn) => { state.commands[id] = fn; return { dispose() {} }; } },
    window: {
      createStatusBarItem: () => Object.assign(state.status, { show() {}, dispose() {} }),
      registerTreeDataProvider: (id, t) => { state.tree = t; return { dispose() {} }; },
      withProgress: (o, fn) => fn(),
      showWarningMessage: async (m) => { state.warnings.push(m); }, showInformationMessage: async () => {}, showErrorMessage: async (m) => { throw new Error(m); },
      showTextDocument: async (doc, opts) => { state.opened = { doc, opts }; },
      createWebviewPanel: () => ({
        webview: { html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u.fsPath, postMessage: (m) => { state.posted.push(m); return true; }, onDidReceiveMessage: (fn) => { state.onMessage = fn; } },
        onDidDispose() {}, reveal() {},
      }),
    },
  };
  return api;
}
const until = async (cond, ms = 8000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('tiempo agotado'); await new Promise((r) => setTimeout(r, 25)); } };

test('extensión: activación, panel, guardar, confirmar y flujo en vivo', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ext-')));
  fs.cpSync(path.join(__dirname, '..', 'examples', 'restaurante'), root, { recursive: true, filter: (s) => !s.includes('.spectator') });
  const vscode = fakeVscode(root);
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : load.call(this, request, ...rest); };
  const ext = require('../src/extension');
  Module._load = load;
  const S = vscode.state;
  const ctx = { subscriptions: [], extensionUri: vscode.Uri.file(path.join(__dirname, '..')) };
  ext.activate(ctx);
  try {

  await until(() => S.status.text);
  assert.match(S.status.text, /fallas/);
  const rows = S.tree.getChildren();
  // Cabecera, las 10 áreas con avisos, una fila que resume las áreas sin avisos y los accesos al mapa y a las reglas.
  assert.strictEqual(rows.length, 1 + 10 + 1 + 2);
  assert.strictEqual(rows[11].label, '1 área sin avisos');
  assert.deepStrictEqual(rows.slice(-2).map((r) => r.command.arguments[0].tab), ['flow', 'statements']);
  assert.ok(S.diagnostics.has(path.join(root, 'src/services/paymentService.js')));

  S.commands['spectator.open']();
  assert.match(ctx.subscriptions.length ? 'ok' : '', /ok/);
  await S.onMessage({ type: 'ready' });
  const data = S.posted.find((m) => m.type === 'data').data;
  assert.strictEqual(data.verdict, 'fail');

  await S.onMessage({ type: 'open', file: 'src/config.js', line: 4 });
  assert.ok(S.opened.doc.file.endsWith(path.join('src', 'config.js')));
  S.opened = null;
  await S.onMessage({ type: 'open', file: '../../etc/passwd', line: 1 });
  assert.strictEqual(S.opened, null, 'no abre rutas fuera del proyecto');

  // Guardar un archivo con un problema nuevo -> aviso «tu último cambio introdujo…»
  const file = path.join(root, 'src/config.js');
  fs.appendFileSync(file, '\nconst API_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";\n');
  S.posted.length = 0;
  S.onSave({ uri: vscode.Uri.file(file) });
  await until(() => S.warnings.length);
  assert.match(S.warnings[0], /introdujo 1 aviso nuevo/);

  // Confirmar un statement lo convierte en norma del proyecto.
  S.posted.length = 0;
  await S.onMessage({ type: 'confirm', statement: data.statements.find((s) => s.name === 'MAX_ITEMS_PER_ORDER') });
  const confirmed = () => S.posted.some((m) => m.type === 'data' && m.data.statements.find((s) => s.name === 'MAX_ITEMS_PER_ORDER').status === 'ok');
  await until(confirmed);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'spectator.json'), 'utf8'));
  assert.ok(cfg.contract.some((c) => c.name === 'MAX_ITEMS_PER_ORDER' && c.value === 20));

  // Flujo en vivo
  fs.writeFileSync(path.join(root, 'run.js'), "require('./src/services/userService').checkAge({ age: 30 });\n");
  S.posted.length = 0;
  await S.onMessage({ type: 'trace', command: 'node run.js' });
  await until(() => S.posted.some((m) => m.type === 'traceEnd'));
  assert.ok(S.posted.some((m) => m.type === 'trace' && m.delta['src/services/userService.js#checkAge'] === 1));
  } finally {
    // Siempre se cierra el proceso del motor, también si falla una comprobación.
    for (const d of ctx.subscriptions) d.dispose && d.dispose();
  }
});
