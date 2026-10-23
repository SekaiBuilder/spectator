'use strict';
// Cronología: cada archivo que cambió hoy y qué IA lo cambió, solo con evidencia (registros locales y commits).
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { aiEdits, chronology } = require('../src/core/provenance');
const { Engine } = require('../src/core');
const { setLocale } = require('../src/core/i18n');
const { project, ui } = require('./helpers');

setLocale('es');
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function fakeHome(t, root) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spectator-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Claude Code: una edición aplicada, una rechazada y una escritura completa.
  const dir = path.join(home, '.claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const use = (id, name, input, at) => JSON.stringify({ type: 'assistant', timestamp: at, sessionId: 's1', message: { content: [{ type: 'tool_use', id, name, input }] } });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), [
    JSON.stringify({ type: 'user', message: { content: 'Arregla el servicio, por favor (texto privado que nunca se lee)' } }),
    use('t1', 'Edit', { file_path: path.join(root, 'src/service.js'), old_string: 'return 1;', new_string: 'return 2;\n// arreglado' }, iso(60000)),
    use('t2', 'Edit', { file_path: path.join(root, 'src/otro.js'), old_string: 'a', new_string: 'b' }, iso(50000)),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'The user rejected the edit' }] } }),
    use('t3', 'Write', { file_path: path.join(root, 'src/nuevo.js'), content: 'export const z = 1;\n' }, iso(40000)),
    use('t4', 'Edit', { file_path: '/fuera/del/proyecto.js', old_string: 'x', new_string: 'y' }, iso(30000)),
    JSON.stringify({ type: 'assistant', timestamp: iso(25000), cwd: root, message: { content: [{ type: 'tool_use', id: 't5', name: 'Bash', input: { command: 'npm test' } }] } }),
  ].join('\n'));
  // Codex: un parche que crea un archivo y modifica otro.
  const d = new Date();
  const cdir = path.join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(cdir, { recursive: true });
  const patch = `*** Begin Patch\n*** Update File: ${path.join(root, 'src/service.js')}\n@@\n-  return 2;\n+  return 3;\n*** Add File: src/codex.js\n+export const c = 1;\n*** End Patch`;
  fs.writeFileSync(path.join(cdir, 'rollout-x.jsonl'), [
    JSON.stringify({ timestamp: iso(70000), type: 'session_meta', payload: { cwd: root } }),
    JSON.stringify({ timestamp: iso(20000), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: `await tools.apply_patch(${JSON.stringify(patch)})` } }),
    JSON.stringify({ timestamp: iso(19000), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'Success. Updated the following files' } }),
  ].join('\n'));
  return home;
}

test('las ediciones de Claude Code y Codex se atribuyen; las rechazadas o de fuera del proyecto, no', (t) => {
  const root = project(t, { 'src/service.js': 'return 3;\n' });
  const home = fakeHome(t, root);
  const edits = aiEdits(root, { since: Date.now() - 3600e3, home });
  assert.deepEqual(edits.map((e) => [e.agent, e.file, e.action]), [
    ['Claude Code', 'src/service.js', 'edit'],
    ['Claude Code', 'src/nuevo.js', 'write'],
    ['Codex', 'src/service.js', 'edit'],
    ['Codex', 'src/codex.js', 'create'],
  ]);
  const first = edits[0];
  assert.equal(first.before, 'return 1;');
  assert.equal(first.after, 'return 2;\n// arreglado');
  assert.deepEqual([first.added, first.removed], [2, 1]);
  assert.deepEqual([edits[2].before, edits[2].after], ['  return 2;', '  return 3;']);
  assert.ok(!JSON.stringify(edits).includes('texto privado'), 'las conversaciones no se leen');
  assert.deepEqual(edits.commands.map((c) => c.command), ['npm test'], 'las órdenes de terminal se guardan aparte, como pista');
  assert.deepEqual(aiEdits(root, { since: Date.now() - 3600e3, home, logs: false }), [], 'con el ajuste desactivado no se leen los registros');
});

test('un commit firmado por una IA cuenta como evidencia; uno que solo la menciona, no', (t) => {
  const root = project(t, { 'a.js': '1\n', 'b.js': '1\n' });
  const git = (...a) => childProcess.execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  git('init', '-q'); git('add', 'a.js'); git('-c', 'user.email=a@b', '-c', 'user.name=Ana', 'commit', '-qm', 'cambio a mano');
  git('add', 'b.js'); git('-c', 'user.email=a@b', '-c', 'user.name=Ana', 'commit', '-qm', 'Añade b\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  const edits = aiEdits(root, { since: Date.now() - 3600e3, home: os.tmpdir(), logs: false });
  assert.deepEqual(edits.map((e) => [e.agent, e.file, e.via]), [['Claude Code', 'b.js', 'git']]);
});

test('la cronología une lo que Spectator vio con la IA que lo hizo y deja el resto sin atribuir', () => {
  const ai = [{ agent: 'Claude Code', at: iso(60000), file: 'src/service.js', action: 'edit', via: 'claude-log' }];
  const observed = [
    { at: iso(55000), file: 'src/service.js', kind: 'modified', source: 'external', newFindings: [{ id: 'x', title: 'eval', severity: 'fail' }] },
    { at: iso(10000), file: 'src/manual.js', kind: 'modified', source: 'vscode' },
  ];
  const c = chronology({ ai, observed });
  assert.deepEqual(c.entries.map((e) => [e.file, e.who, e.source]), [['src/manual.js', null, 'vscode'], ['src/service.js', 'Claude Code', 'claude-log']]);
  // Una orden de terminal de la IA que nombra el archivo justo antes del cambio: atribución probable, no segura.
  const hint = chronology({ ai: [], observed: [{ at: iso(5000), file: 'src/manual.js', kind: 'modified', source: 'external' }], commands: [{ agent: 'Claude Code', at: iso(9000), command: "sed -i '' 's/a/b/' src/manual.js", via: 'claude-bash' }] });
  assert.deepEqual(hint.entries.map((e) => [e.who, e.certainty, e.source]), [['Claude Code', 'probable', 'claude-bash']]);
  const far = chronology({ ai: [], observed: [{ at: iso(5000), file: 'src/manual.js', kind: 'modified', source: 'external' }], commands: [{ agent: 'Claude Code', at: iso(600000), command: 'touch src/manual.js', via: 'claude-bash' }] });
  assert.equal(far.entries[0].who, null, 'una orden de hace 10 minutos no sirve de pista');
  assert.equal(c.entries[1].newFindings.length, 1, 'el aviso nuevo queda con el cambio de la IA');
  assert.deepEqual(c.agents.map((a) => [a.who, a.edits]), [['Claude Code', 1], [null, 1]]);
});

test('la interfaz muestra la cronología con quién hizo cada cambio y el fragmento cambiado', async (t) => {
  const root = project(t, { 'src/service.js': 'module.exports = 1;\n' });
  const data = JSON.parse(JSON.stringify(await new Engine(root).scan({ git: false })));
  const page = ui(data, { tab: 'cronologia' });
  assert.ok(page.posted.some((m) => m.type === 'chronology'), 'pide la cronología al abrirse');
  page.send({ type: 'chronology', data: chronology({ ai: [{ agent: 'Claude Code', at: iso(60000), file: 'src/service.js', action: 'edit', before: 'return 1;', after: 'return 2;', added: 1, removed: 1, via: 'claude-log' }], observed: [{ at: iso(5000), file: 'src/otro.js', kind: 'modified', source: 'vscode' }] }) });
  const text = page.text();
  assert.match(text, /Claude Code · 1 cambios en 1 archivos/);
  assert.match(text, /Sin IA detectada/);
  page.all((n) => n.tag === 'button' && n.attrs.class === 'event-head' && n.textContent.includes('service.js'))[0].events.click();
  assert.match(page.text(), /- return 1;/);
  assert.match(page.text(), /\+ return 2;/);
  page.button('Comparar con el último commit').events.click();
  assert.ok(page.posted.some((m) => m.type === 'diffHead' && m.file === 'src/service.js'));
});

test('la interfaz muestra el mapa del backend: endpoint, recorrido, DTO y lo que pasa si falla', async () => {
  const data = JSON.parse(JSON.stringify(await new Engine(path.join(__dirname, '..', 'examples', 'tienda-spring')).scan({ git: false })));
  const page = ui(data, { tab: 'backend' });
  assert.match(page.text(), /Tu backend en palabras sencillas/);
  page.all((n) => n.tag === 'button' && n.attrs.class === 'head' && n.textContent.startsWith('POST/api/pedidos'))[0].events.click();
  const text = page.text();
  assert.match(text, /Qué recibe/);
  assert.match(text, /CrearPedidoRequest/);
  assert.match(text, /mínimo 1/);
  assert.match(text, /Por dónde pasa/);
  assert.match(text, /PedidoRepository\.save — guarda en la base de datos/);
  assert.match(text, /llama a GET https:\/\/api\.proveedor\.com\/productos\/\{id\}/);
  assert.match(text, /201 creado/);
  assert.match(text, /RecursoNoEncontrado → 404 no existe \(lo convierte ManejadorErrores\.noEncontrado\)/);
  assert.doesNotMatch(text, /\[object |undefined|null/);
  fs.rmSync(path.join(__dirname, '..', 'examples', 'tienda-spring', '.spectator'), { recursive: true, force: true });
});
