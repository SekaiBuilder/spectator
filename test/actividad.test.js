'use strict';
// Trabajar con Spectator junto a otro editor (IntelliJ, Xcode…): cambios de archivos, vigía de API y errores de log.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { Engine } = require('../src/core');
const { startApiWatch, guessTarget } = require('../src/core/apiwatch');
const { watchLogs } = require('../src/core/logwatch');
const { projectFrames } = require('../src/core/stack');
const { explainStatus, explainNetworkError } = require('../src/core/http-status');
const { setLocale } = require('../src/core/i18n');
const { project, ui, activate, until, sleep } = require('./helpers');

const git = (root, ...args) => childProcess.execFileSync('git', args, { cwd: root, stdio: 'ignore' });
const JAVA = {
  'src/main/java/com/tienda/OrderService.java': 'package com.tienda;\npublic class OrderService {\n  public int crear(Order o) { return o.total(); }\n}\n',
  'src/main/java/com/tienda/OrderController.java': 'package com.tienda;\npublic class OrderController {\n  OrderService s = new OrderService();\n  int post(Order o) { return s.crear(o); }\n}\n',
  'src/main/java/com/tienda/Order.java': 'package com.tienda;\npublic class Order { int total() { return 1; } }\n',
  'src/main/resources/application.properties': 'server.port=8181\n',
};

test('los cambios se ven aunque vengan de otro editor, con Git, avisos nuevos y posible impacto', async (t) => {
  const root = project(t, { 'lib.js': 'export function f() { return 1; }\n', 'main.js': "import { f } from './lib.js';\nconsole.log(f());\n" });
  git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'base');
  const engine = new Engine(root);
  const first = await engine.scan();
  assert.equal(first.changes.files.length, 0);
  assert.ok(first.changes.git.branch);
  // Otro editor modifica lib.js y crea un archivo nuevo.
  fs.writeFileSync(path.join(root, 'lib.js'), 'export function f() { eval("1"); return 1; }\n');
  fs.writeFileSync(path.join(root, 'nuevo.js'), 'export const z = 1;\n');
  const second = await engine.scan();
  const lib = second.changes.files.find((f) => f.rel === 'lib.js');
  assert.equal(lib.git, 'modified');
  assert.equal(lib.sinceLastScan, 'modified');
  assert.deepEqual([lib.added, lib.removed], [1, 1]);
  assert.ok(lib.newFindings.some((f) => /eval/.test(f.title)));
  assert.deepEqual(lib.dependents, ['main.js'], 'main.js importa lib.js: podría verse afectado');
  assert.equal(second.changes.files.find((f) => f.rel === 'nuevo.js').git, 'untracked');
  // Sin Git también se ven los cambios entre análisis.
  fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, 'main.js'), "import { f } from './lib.js';\nconsole.log(f(), 2);\n");
  const third = await engine.scan();
  assert.equal(third.changes.git, null);
  assert.deepEqual(third.changes.files.map((f) => [f.rel, f.sinceLastScan]), [['main.js', 'modified']]);
});

test('las trazas de Java, Node y Python llevan al archivo y la línea del proyecto', () => {
  const files = ['src/main/java/com/tienda/OrderService.java', 'src/otro/OrderService.java', 'src/orders.js', 'app/users.py'];
  const java = 'java.lang.NullPointerException\n\tat com.tienda.OrderService.crear(OrderService.java:42)\n\tat org.springframework.web.Servlet.service(Servlet.java:10)';
  assert.deepEqual(projectFrames(java, files, '/p').map((f) => [f.file, f.line]), [['src/main/java/com/tienda/OrderService.java', 42]], 'el paquete decide entre archivos homónimos; las librerías no cuentan');
  assert.deepEqual(projectFrames('TypeError: x\n    at crear (/p/src/orders.js:10:5)\n    at /p/node_modules/express/lib/router.js:1:1', files, '/p').map((f) => [f.file, f.line]), [['src/orders.js', 10]]);
  assert.deepEqual(projectFrames('Traceback (most recent call last):\n  File "/p/app/users.py", line 19, in crear\nKeyError', files, '/p').map((f) => [f.file, f.line]), [['app/users.py', 19]]);
});

test('cada respuesta se explica en lenguaje sencillo, también las que no son errores', () => {
  setLocale('es');
  assert.equal(explainStatus(304).level, 'redirect');
  assert.match(explainStatus(304).meaning, /No es un error/);
  assert.equal(explainStatus(200).level, 'ok');
  assert.equal(explainStatus(500).title, 'Error interno del servidor');
  assert.equal(explainStatus(418).level, 'client', 'un código sin texto propio usa el de su familia');
  assert.equal(explainNetworkError('ECONNREFUSED').title, 'La aplicación no responde');
  setLocale('en');
  assert.equal(explainStatus(404).title, 'Not found');
  setLocale('es');
});

test('el vigía de API deja pasar cada llamada, la registra y explica los errores sin guardar secretos', async (t) => {
  const root = project(t, { 'src/orders.js': 'module.exports = 1;\n' });
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    if (req.url === '/app.js') { res.writeHead(200); return res.end('x'); }
    if (req.url === '/falla') {
      const body = JSON.stringify({ message: 'Cannot read total of null', stack: `TypeError: x\n    at crear (${root}/src/orders.js:10:5)`, password: 'MuySecreta1', token: 'abc' });
      res.writeHead(500, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      return res.end(zlib.gzipSync(body));
    }
    res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>Not Found</h1><p>Bearer abcdefghijklmnop</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const events = [];
  const watch = await startApiWatch({ target: `http://127.0.0.1:${server.address().port}`, port: 0, root, files: () => ['src/orders.js'], onEvent: (e) => events.push(e) });
  t.after(() => watch.stop());
  const get = (p, headers = {}) => new Promise((resolve) => http.get(watch.url + p, { headers }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, body: b, headers: r.headers })); }));

  assert.deepEqual((await get('/ok', { authorization: 'Bearer secreto-que-no-se-guarda' })).body, '{"ok":true}');
  const failed = await get('/falla');
  assert.equal(failed.status, 500);
  assert.equal(failed.headers['content-encoding'], 'gzip', 'la respuesta llega intacta a quien llama');
  await get('/nada');
  await get('/app.js');
  await until(() => events.length === 4);
  const [ok, boom, missing, asset] = events;
  assert.equal(ok.status, 200);
  assert.equal(ok.explanation.level, 'ok');
  assert.ok(!JSON.stringify(events).includes('secreto-que-no-se-guarda'), 'las cabeceras de autenticación no se guardan');
  assert.equal(boom.explanation.title, 'Error interno del servidor');
  assert.equal(boom.message, 'Cannot read total of null');
  assert.deepEqual(boom.frames.map((f) => [f.file, f.line]), [['src/orders.js', 10]]);
  assert.ok(!boom.body.includes('MuySecreta1') && !boom.body.includes('"abc"'), 'contraseñas y tokens se enmascaran');
  assert.equal(missing.status, 404);
  assert.ok(!missing.body.includes('abcdefghijklmnop'));
  assert.equal(asset.asset, true);

  // Si la aplicación no está arrancada, quien llama recibe una explicación y la actividad lo registra.
  await new Promise((r) => server.close(r));
  const down = await get('/ok');
  assert.equal(down.status, 502);
  assert.match(down.body, /La aplicación no responde/);
  await until(() => events.length === 5);
  assert.equal(events[4].error, 'ECONNREFUSED');
});

test('el vigía usa otro puerto si el elegido está ocupado y rechaza URLs inválidas', async (t) => {
  const busy = http.createServer();
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  t.after(() => busy.close());
  const watch = await startApiWatch({ target: 'http://localhost:9', port: busy.address().port });
  assert.notEqual(watch.port, busy.address().port);
  await watch.stop();
  await assert.rejects(startApiWatch({ target: 'ftp://x' }), /invalid-target/);
});

test('los errores del log se leen en vivo y llevan a la línea del proyecto', async (t) => {
  const root = project(t, JAVA);
  const log = path.join(root, 'app.log');
  fs.writeFileSync(log, 'ERROR antiguo que no se repite\n');
  const events = [];
  const w = watchLogs({ files: [log], root, projectFiles: () => Object.keys(JAVA), interval: 50, onEvent: (e) => events.push(e) });
  t.after(() => w.stop());
  await sleep(120);
  fs.appendFileSync(log, '2026-10-17 INFO arrancado\n2026-10-17 ERROR 1 --- [nio] Servlet.service() threw exception\njava.lang.NullPointerException: order is null\n\tat com.tienda.OrderService.crear(OrderService.java:3)\n\tat com.tienda.OrderController.post(OrderController.java:4)\nCaused by: java.sql.SQLException: password=x\n2026-10-17 INFO sigue\n');
  await until(() => events.length);
  assert.equal(events.length, 1, 'el error antiguo no se repite y la traza es un solo evento');
  assert.match(events[0].headline, /NullPointerException: order is null/);
  assert.match(events[0].cause, /SQLException/);
  assert.deepEqual(events[0].frames.map((f) => [f.file, f.line]), [['src/main/java/com/tienda/OrderService.java', 3], ['src/main/java/com/tienda/OrderController.java', 4]]);
});

test('la URL del servidor se deduce del proyecto sin ejecutar nada', (t) => {
  assert.deepEqual(guessTarget(project(t, JAVA)), { url: 'http://localhost:8181', reason: 'src/main/resources/application.properties: server.port' });
  assert.equal(guessTarget(project(t, { 'package.json': '{"scripts":{"dev":"vite"}}' })).url, 'http://localhost:5173');
  assert.equal(guessTarget(project(t, {})).url, 'http://localhost:8080');
});

test('la extensión registra cambios hechos desde otro editor y la API vigilada sin interrumpir', async (t) => {
  const root = project(t, { 'lib.js': 'export function f() { return 1; }\n' });
  const target = http.createServer((req, res) => { res.writeHead(req.url === '/x' ? 500 : 200); res.end('boom'); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  t.after(() => target.close());
  const { S } = await activate(t, [root]);
  S.posted.length = 0;
  // IntelliJ guarda lib.js: no hay aviso emergente, pero aparece en Actividad.
  fs.writeFileSync(path.join(root, 'lib.js'), 'export function f() { eval("1"); return 1; }\n');
  S.fsw.change(path.join(root, 'lib.js'));
  await until(() => S.posted.some((m) => m.type === 'activity' && m.event.type === 'files'));
  const ev = S.posted.find((m) => m.type === 'activity').event;
  assert.equal(ev.source, 'external');
  assert.ok(ev.files[0].newFindings.length);
  assert.deepEqual(S.warnings, [], 'un cambio desde otro editor no abre ventanas emergentes');

  await S.onMessage({ type: 'watchApi', target: `http://127.0.0.1:${target.address().port}` });
  const state = S.posted.filter((m) => m.type === 'activityState').pop();
  assert.ok(state.api && state.api.url);
  await new Promise((r) => http.get(state.api.url + '/x', (res) => { res.resume(); res.on('end', r); }));
  await until(() => S.posted.some((m) => m.type === 'activity' && m.event.type === 'api'));
  assert.equal(S.posted.find((m) => m.type === 'activity' && m.event.type === 'api').event.status, 500);
  assert.match(S.status.text, /1 errores de API/);
  await S.onMessage({ type: 'stopApi' });
  assert.equal(S.posted.filter((m) => m.type === 'activityState').pop().api, null);
});

test('la interfaz pone primero lo que acaba de fallar y explica el error con su archivo', async (t) => {
  const root = project(t, { 'src/orders.js': 'module.exports = function crear() { return 1; };\n' });
  const data = JSON.parse(JSON.stringify(await new Engine(root).scan()));
  const page = ui(data);
  const at = new Date().toISOString();
  page.send({ type: 'activityState', api: { url: 'http://localhost:8099', target: 'http://localhost:8080' }, logs: [], events: [
    { type: 'api', id: 1, at, method: 'GET', path: '/ok', status: 200, ms: 3, explanation: explainStatus(200), frames: [] },
    { type: 'api', id: 2, at, method: 'POST', path: '/orders', status: 500, ms: 9, message: 'order is null', explanation: explainStatus(500), frames: [{ file: 'src/orders.js', line: 10, fn: 'crear' }] },
  ] });
  assert.match(page.text(), /Tu API respondió 500 en POST \/orders/);
  page.button('Ver qué pasó').events.click();
  const text = page.text();
  assert.match(text, /Error interno del servidor/);
  assert.match(text, /El servidor dice/);
  assert.match(text, /order is null/);
  page.button('src/orders.js:10').events.click();
  assert.deepEqual(JSON.parse(JSON.stringify(page.posted.find((m) => m.type === 'open'))), { type: 'open', file: 'src/orders.js', line: 10 });
  page.button('Solo errores').events.click();
  assert.doesNotMatch(page.text(), /GET \/ok/);
  page.button('Profesional').events.click();
  assert.ok(page.posted.some((m) => m.type === 'mode' && m.mode === 'pro'));
});
