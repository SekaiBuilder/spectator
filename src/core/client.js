'use strict';
// Misma interfaz que Engine, pero el trabajo ocurre en un proceso hijo (ver worker.js).
const { fork } = require('child_process');
const path = require('path');
const { killTree } = require('./util');

// Las gramáticas grandes (Swift) agotan la memoria del compilador optimizador de WebAssembly
// en algunas versiones de V8; con el compilador base no ocurre.
const V8_FLAGS = ['--liftoff-only'];

class EngineClient {
  constructor(root) {
    this.root = root;
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.traceHandlers = null;
    this.tracePids = new Set();
    this.useFlags = true;
    this.disposed = false;
  }

  start() {
    if (this.disposed) throw new Error('analyzer-disposed');
    if (this.child) return;
    const started = Date.now();
    const child = fork(path.join(__dirname, 'worker.js'), [], { execArgv: this.useFlags ? V8_FLAGS : [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.child = child;
    child.on('message', (m) => {
      if (m.event) {
        const h = this.traceHandlers || {};
        if (m.event === 'pid') this.tracePids.add(m.pid);
        else if (m.event === 'update' && h.onUpdate) h.onUpdate(m.data);
        else if (m.event === 'output' && h.onOutput) h.onOutput(m.data);
        else if (m.event === 'exit') { this.traceHandlers = null; this.tracePids.clear(); h.onExit && h.onExit(m.data); }
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
    });
    const gone = () => {
      if (this.child !== child) return;
      this.child = null;
      // Si muere nada más arrancar, este runtime no acepta los flags: se reintenta sin ellos.
      if (this.useFlags && Date.now() - started < 1500) this.useFlags = false;
      for (const p of this.pending.values()) p.reject(new Error('analyzer-stopped'));
      this.pending.clear();
      // Una ejecución en vivo no puede terminar si su proceso ya no existe: se avisa para que nadie quede esperando,
      // y el programa que ejecutaba no se queda huérfano.
      this.stopOrphan();
      this.failTrace(this.traceHandlers, new Error('analyzer-stopped'));
    };
    child.on('exit', gone);
    child.on('error', gone);
    this.call('init', this.root).catch(() => {});
  }

  call(method, ...args) {
    return new Promise((resolve, reject) => {
      this.start();
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      // Un envío que falla después de aceptarse también cierra su solicitud.
      const failed = (e) => { if (e && this.pending.delete(id)) reject(e); };
      try { this.child.send({ id, method, args }, failed); } catch (e) { failed(e); }
    });
  }

  async scan(opts = {}) {
    try { return await this.call('scan', opts); } catch (e) {
      if (e.message !== 'analyzer-stopped') throw e;
      return this.call('scan', opts); // un reintento con un proceso nuevo
    }
  }
  confirmStatement(s, value) { return this.call('confirmStatement', s, value); }
  ignoreFinding(fingerprint) { return this.call('ignoreFinding', fingerprint); }
  excludeFiles(list) { return this.call('excludeFiles', list); }
  /** Cierra una ejecución en vivo que no pudo iniciarse o perdió su proceso. Solo actúa si sigue siendo la vigente. */
  failTrace(handlers, error) {
    if (!handlers || this.traceHandlers !== handlers) return;
    this.traceHandlers = null;
    handlers.onError && handlers.onError(error);
  }
  trace(command, handlers = {}) {
    this.traceHandlers = handlers;
    this.tracePids.clear(); // la ejecución anterior la detiene el motor al sustituirla
    this.call('trace', command).catch((e) => this.failTrace(handlers, e));
    return { stop: () => this.child && this.call('stopTrace').catch(() => {}) };
  }
  /** El motor ya no puede detener el programa que lanzó: se termina desde aquí (el shell y cada programa observado). */
  stopOrphan() {
    for (const pid of this.tracePids) killTree(pid, 'SIGKILL');
    this.tracePids.clear();
  }
  /** Cierre definitivo: ninguna solicitud ni ejecución en vivo queda esperando una respuesta que ya no llegará. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const c = this.child;
    this.child = null;
    for (const p of this.pending.values()) p.reject(new Error('analyzer-disposed'));
    this.pending.clear();
    this.failTrace(this.traceHandlers, new Error('analyzer-disposed'));
    // En Windows kill() no deja al motor detener su ejecución en vivo.
    this.stopOrphan();
    if (c) c.kill();
  }
}

module.exports = { EngineClient };
