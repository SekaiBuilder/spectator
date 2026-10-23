'use strict';
// Pruebas dentro de VS Code real (no un doble): se ejecutan con `npm run test:vscode`, que abre una ventana aparte
// con un perfil temporal. Comprueban activación, diagnósticos, cambios hechos desde fuera del editor, vigía de API y logs.
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 20000, what = 'condición') {
  const t0 = Date.now();
  for (;;) { const v = await cond(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('tiempo agotado esperando ' + what); await sleep(100); }
}

async function run() {
  const results = [];
  const out = process.env.SPECTATOR_TEST_OUT;
  const step = async (name, fn) => {
    const t0 = Date.now();
    try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); }
    catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, error: String(e && e.stack || e) }); }
  };
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  let T;
  await step('la extensión se activa y analiza la carpeta abierta', async () => {
    const ext = vscode.extensions.getExtension('spectator.spectator');
    assert.ok(ext, 'extensión encontrada');
    T = (await ext.activate())._test;
    await until(() => T.result(), 60000, 'primer análisis');
    assert.ok(T.result().graph.files.length > 3);
  });
  await step('los comandos están registrados', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of ['spectator.open', 'spectator.scan', 'spectator.activity', 'spectator.watchApi', 'spectator.stopApi', 'spectator.watchLogs', 'spectator.trace']) assert.ok(all.includes(c), c);
  });
  await step('los avisos aparecen subrayados en el editor', async () => {
    const diags = await until(() => vscode.languages.getDiagnostics().filter(([, list]) => list.some((d) => d.source === 'Spectator')), 20000, 'diagnósticos');
    assert.ok(diags.length > 0);
  });
  await step('el panel carga y pinta todas las pestañas sin errores', async () => {
    await vscode.commands.executeCommand('spectator.open');
    await until(() => T.webviewReady(), 20000, 'panel cargado');
    for (const tab of ['resumen', 'cronologia', 'actividad', 'vivo', 'problemas', 'backend', 'flow', 'statements', 'resumen']) { T.show({ tab }); await sleep(400); }
    await vscode.commands.executeCommand('spectator.activity');
    await sleep(400);
    assert.deepEqual(T.clientErrors(), []);
  });
  await step('un cambio hecho fuera de VS Code (como IntelliJ) aparece en Actividad', async () => {
    const file = path.join(root, 'src', 'config.js');
    fs.appendFileSync(file, '\nconst X = eval("1");\n');
    const ev = await until(() => T.activity().find((e) => e.type === 'files' && e.files.some((f) => f.rel === 'src/config.js')), 20000, 'evento de cambio');
    assert.equal(ev.source, 'external');
    assert.ok(ev.files.find((f) => f.rel === 'src/config.js').newFindings.length > 0, 'detecta el aviso nuevo');
    const changed = T.result().changes.files.find((f) => f.rel === 'src/config.js');
    assert.ok(changed && changed.git === 'modified', 'Git lo marca como modificado');
    assert.ok(changed.dependentsCount > 0, 'calcula quién depende del archivo');
  });
  await step('el vigía de API explica un error 500 con su archivo y línea', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/ok') { res.writeHead(200); return res.end('ok'); }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'order is null', stack: `TypeError: order is null\n    at crear (${path.join(root, 'src/services/orderService.js')}:12:5)` }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const cfg = vscode.workspace.getConfiguration('spectator');
      await cfg.update('api.target', `http://127.0.0.1:${server.address().port}`, vscode.ConfigurationTarget.Workspace);
      await cfg.update('api.port', 0, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('spectator.watchApi');
      const info = await until(() => T.api(), 10000, 'vigía activo');
      for (const p of ['/ok', '/pedidos']) await new Promise((resolve, reject) => http.get(info.url + p, (r) => { r.resume(); r.on('end', resolve); }).on('error', reject));
      const ev = await until(() => T.activity().find((e) => e.type === 'api' && e.status === 500), 10000, 'evento 500');
      assert.equal(ev.explanation.level, 'server');
      assert.equal(ev.message, 'order is null');
      assert.deepEqual(ev.frames.map((f) => [f.file, f.line]), [['src/services/orderService.js', 12]]);
      assert.ok(T.activity().some((e) => e.type === 'api' && e.status === 200));
      await vscode.commands.executeCommand('spectator.stopApi');
      await until(() => !T.api(), 5000, 'vigía detenido');
    } finally { server.close(); }
  });
  await step('los errores del log llevan a la línea del proyecto', async () => {
    const log = path.join(root, 'app.log');
    fs.writeFileSync(log, 'arranque\n');
    T.startLogs([log]);
    await sleep(900);
    fs.appendFileSync(log, `ERROR fallo al crear pedido\nTypeError: Cannot read properties of null\n    at crear (${path.join(root, 'src/services/orderService.js')}:12:5)\n`);
    const ev = await until(() => T.activity().find((e) => e.type === 'log'), 10000, 'evento de log');
    assert.equal(ev.frames[0].file, 'src/services/orderService.js');
    T.startLogs([]);
  });
  await step('la cronología lista los archivos cambiados hoy', async () => {
    const c = T.chronology();
    assert.ok(!c.error, c.error);
    assert.ok(c.entries.some((e) => e.file === 'src/config.js'), 'el cambio hecho desde fuera aparece en la cronología');
    T.show({ tab: 'cronologia' });
    await sleep(600);
    assert.deepEqual(T.clientErrors(), []);
  });
  await step('el panel sigue sin errores tras recibir actividad de API y logs', async () => {
    T.show({ tab: 'actividad' });
    await sleep(600);
    assert.deepEqual(T.clientErrors(), []);
  });
  await step('el modo Profesional se guarda en los ajustes', async () => {
    await vscode.workspace.getConfiguration('spectator').update('mode', 'pro', vscode.ConfigurationTarget.Workspace);
    assert.equal(vscode.workspace.getConfiguration('spectator').get('mode'), 'pro');
  });
  await step('con dos carpetas abiertas, cada una tiene su análisis y se cambia de una a otra', async () => {
    const folders = vscode.workspace.workspaceFolders;
    assert.equal(folders.length, 2, 'el área de trabajo tiene dos carpetas');
    const other = folders[1].uri.fsPath;
    const first = T.result();
    assert.ok(await T.switchRoot(other), 'cambia a la segunda carpeta');
    await until(() => T.result() && T.result().backend && T.result().backend.framework === 'fastapi', 60000, 'análisis de la carpeta FastAPI');
    assert.ok(T.result().backend.endpoints.length >= 4);
    assert.ok(T.result().backend.endpoints.every((e) => e.example && e.example.curl), 'cada endpoint trae su prueba');
    T.show({ tab: 'backend' }); await sleep(600);
    assert.deepEqual(T.clientErrors(), []);
    assert.ok(await T.switchRoot(root), 'vuelve a la primera');
    assert.equal(T.result(), first, 'la primera conserva su análisis sin repetirlo');
  });
  if (out) fs.writeFileSync(out, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error(failed.map((f) => f.name + ': ' + f.error).join('\n'));
}

module.exports = { run };
