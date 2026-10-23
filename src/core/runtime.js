'use strict';
// Flujo en vivo para Node.js: lanza el comando con el inspector de V8 activado y consulta cada ~400 ms
// qué funciones se han ejecutado (cobertura precisa con contador). No instrumenta ni modifica el código.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { fileURLToPath } = require('url');
const { hash, writeJson, stateDir } = require('./util');

/** Cliente WebSocket mínimo (solo texto) para hablar con el inspector sin dependencias. */
function wsConnect(url, onMessage, onClose) {
  const u = new URL(url);
  const key = crypto.randomBytes(16).toString('base64');
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': 13, 'Sec-WebSocket-Key': key } });
  const api = { open: false, send() {}, close() { req.destroy(); } };
  req.on('error', () => onClose());
  req.on('upgrade', (res, socket, head) => {
    api.open = true;
    let buf = head && head.length ? head : Buffer.alloc(0);
    let parts = [];
    const pump = () => {
      for (;;) {
        if (buf.length < 2) return;
        const fin = buf[0] & 0x80, op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 8) { socket.destroy(); return; }
        if (op === 0 || op === 1) {
          parts.push(payload);
          if (fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; try { onMessage(JSON.parse(text)); } catch { /* mensaje no JSON */ } }
        }
      }
    };
    socket.on('data', (d) => { buf = buf.length ? Buffer.concat([buf, d]) : d; pump(); });
    socket.on('close', () => { api.open = false; onClose(); });
    socket.on('error', () => {});
    api.send = (obj) => {
      if (!api.open) return;
      const data = Buffer.from(JSON.stringify(obj));
      const mask = crypto.randomBytes(4);
      let header;
      if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
      else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];
      socket.write(Buffer.concat([header, mask, masked]));
    };
    api.close = () => { api.open = false; socket.destroy(); };
    pump();
    api.onopen && api.onopen();
  });
  req.end();
  return api;
}

const NOISE = /^(Debugger listening on|For help, see|Debugger attached|Waiting for the debugger to disconnect|Debugger ending on)/;

/**
 * @param command texto que ejecuta el shell, o lista [ejecutable, ...argumentos] que se ejecuta sin shell
 * @param handlers {onUpdate({delta, totals}), onOutput(text), onExit({exitCode, signal, error, instrumentation, counts, …})}
 * @returns {{stop: Function}}
 */
function startTrace(root, command, irs, handlers = {}) {
  // Índice archivo -> funciones, para traducir (url, offset) del inspector a un nodo del grafo.
  const index = new Map();
  for (const f of irs) if (f.units && f.units.length) index.set(f.rel, f.units);
  // Huella del código que se va a ejecutar: permite saber después si el resultado sigue correspondiendo al código actual.
  const files = {};
  for (const rel of index.keys()) { try { files[rel] = hash(fs.readFileSync(path.join(root, rel), 'utf8')); } catch { /* desapareció: contará como cambiado */ } }
  // En macOS /tmp y /var son enlaces: el inspector informa la ruta real.
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* se usa la ruta tal cual */ }
  const totals = {};
  const sessions = new Set();
  const started = Date.now();
  let stopped = false, exited = false;
  // Que el programa termine bien no demuestra que se haya observado: se cuenta cuántos inspectores se abrieron
  // y cuántas lecturas de cobertura llegaron. Sin lecturas, «cero funciones» no significa «ninguna se ejecutó».
  let inspectors = 0, readings = 0, inspectorError = null;

  const match = (rel, fn) => {
    const units = index.get(rel);
    if (!units || !fn.ranges || !fn.ranges.length) return null;
    const s = fn.ranges[0].startOffset;
    // La función anónima que empieza en 0 es el propio módulo (el archivo al cargarse), no una función del código:
    // contarla como «la primera función del archivo» inflaba sus contadores.
    if (!fn.functionName && s === 0) return null;
    let best = null;
    if (fn.functionName) {
      const same = units.filter((u) => u.name === fn.functionName);
      if (same.length === 1) return same[0];
      for (const u of same) if (!best || Math.abs(u.start - s) < Math.abs(best.start - s)) best = u;
      if (best) return best;
    }
    for (const u of units) if (s >= u.start - 12 && s <= u.start + 40 && s < u.end && (!best || u.start > best.start)) best = u;
    return best;
  };

  const ingest = (result) => {
    const delta = {};
    let any = false;
    for (const script of result || []) {
      if (!script.url || !script.url.startsWith('file://') || script.url.includes('/node_modules/')) continue;
      let rel;
      try { rel = path.relative(realRoot, fs.realpathSync(fileURLToPath(script.url))).split(path.sep).join('/'); } catch { continue; }
      if (rel.startsWith('..') || !index.has(rel)) continue;
      for (const fn of script.functions) {
        const count = fn.ranges[0] && fn.ranges[0].count;
        if (!count) continue;
        const u = match(rel, fn);
        if (!u) continue;
        delta[u.id] = (delta[u.id] || 0) + count;
        totals[u.id] = (totals[u.id] || 0) + count;
        any = true;
      }
    }
    if (any && handlers.onUpdate) handlers.onUpdate({ delta, totals });
  };

  const attach = (url) => {
    let id = 0, timer = null, closing = false;
    const s = wsConnect(url, (msg) => {
      if (msg.id && msg.result && Array.isArray(msg.result.result)) { readings++; ingest(msg.result.result); }
      if (msg.method === 'Runtime.executionContextDestroyed' && !closing) {
        // El proceso terminó y espera a que soltemos el inspector: última lectura y cerrar.
        closing = true;
        s.send({ id: ++id, method: 'Profiler.takePreciseCoverage' });
        setTimeout(() => s.close(), 250);
      }
    }, () => { clearInterval(timer); sessions.delete(s); });
    s.onopen = () => {
      s.send({ id: ++id, method: 'Runtime.enable' });
      s.send({ id: ++id, method: 'Profiler.enable' });
      s.send({ id: ++id, method: 'Profiler.startPreciseCoverage', params: { callCount: true, detailed: false } });
      s.send({ id: ++id, method: 'Runtime.runIfWaitingForDebugger' });
      timer = setInterval(() => { if (!closing) s.send({ id: ++id, method: 'Profiler.takePreciseCoverage' }); }, 400);
    };
    sessions.add(s);
  };

  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --inspect-brk=127.0.0.1:0`.trim() };
  delete env.ELECTRON_RUN_AS_NODE;
  // Una lista de argumentos se ejecuta sin shell para conservar espacios y comillas. En Windows los .cmd necesitan shell.
  const argv = Array.isArray(command) ? command : null;
  const shown = argv ? argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(' ') : command;
  const child = argv && process.platform !== 'win32'
    ? spawn(argv[0], argv.slice(1), { cwd: root, env, detached: true })
    : spawn(argv ? shown : command, { cwd: root, shell: true, env, detached: process.platform !== 'win32' });
  let errBuf = '';
  child.stdout.on('data', (d) => handlers.onOutput && handlers.onOutput(String(d)));
  child.stderr.on('data', (d) => {
    errBuf += String(d);
    const lines = errBuf.split('\n');
    errBuf = lines.pop();
    for (const line of lines) {
      const m = /Debugger listening on (ws:\/\/\S+)/.exec(line);
      if (m) { inspectors++; attach(m[1]); continue; }
      if (/Starting inspector on .* failed/.test(line)) inspectorError = line.trim();
      else if (!NOISE.test(line.trim()) && handlers.onOutput) handlers.onOutput(line + '\n');
    }
  });
  // exitCode es el del programa; si lo terminó una señal queda en null y se informa la señal.
  // error solo aparece cuando el comando no llegó a iniciarse.
  const finish = (code, signal, error) => {
    if (stopped) return;
    stopped = true;
    for (const s of sessions) s.close();
    const instrumentation = !readings ? 'unavailable' : inspectorError ? 'partial' : 'recorded';
    const data = { command: shown, at: new Date().toISOString(), exitCode: code, signal: signal || null, durationMs: Date.now() - started, counts: totals, evidence: 'function-coverage', observedCalls: false, instrumentation };
    if (instrumentation !== 'recorded') data.instrumentationReason = inspectorError ? 'inspector-failed' : inspectors ? 'no-coverage' : 'no-inspector';
    // Si el código cambió mientras se ejecutaba, el resultado ya no corresponde a ningún estado del código.
    const changedFiles = Object.keys(files).filter((rel) => { try { return hash(fs.readFileSync(path.join(root, rel), 'utf8')) !== files[rel]; } catch { return true; } }).sort();
    if (error) data.error = String(error.message || error);
    // Solo se guarda lo que de verdad se observó: un fallo del inspector no sustituye a la última ejecución válida.
    else if (instrumentation !== 'unavailable') { try { writeJson(path.join(stateDir(root), 'runtime.json'), { ...data, files }); } catch { /* solo lectura */ } }
    handlers.onExit && handlers.onExit({ ...data, freshness: changedFiles.length ? 'stale' : 'current', changedFiles: changedFiles.slice(0, 20), changedCount: changedFiles.length });
  };
  child.on('exit', (code, signal) => { exited = true; setTimeout(() => finish(code, signal), 150); });
  child.on('error', (e) => finish(null, null, e));

  return {
    stop() {
      for (const s of sessions) s.close();
      try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']); else process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch { /* ya terminó */ } }
      // Si el programa ignora SIGTERM, a los 3 s se termina todo su grupo de procesos.
      if (process.platform !== 'win32') setTimeout(() => { if (!exited) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ya terminó */ } } }, 3000).unref();
    },
  };
}

module.exports = { startTrace };
