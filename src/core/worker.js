'use strict';
// Proceso hijo que aloja el motor. Así un análisis largo no congela VS Code
// y un fallo del parser nunca puede tumbar el host de extensiones.
const { Engine } = require('./index');

let engine = null;
let tracer = null;
const send = (msg) => { try { process.send(msg); } catch { /* el padre ya no está */ } };

// Las operaciones se atienden de una en una para que dos llamadas no intercalen cambios sobre el mismo motor.
// Detener el flujo en vivo no espera turno: tiene que poder interrumpir.
let queue = Promise.resolve();
process.on('message', (m) => {
  if (m.method === 'stopTrace') { tracer && tracer.stop(); send({ id: m.id }); return; }
  queue = queue.then(() => handle(m));
});

async function handle(m) {
  try {
    let result;
    if (m.method !== 'init' && !engine) throw new Error('analyzer-not-initialized');
    if (m.method === 'init') engine = new Engine(m.args[0]);
    else if (m.method === 'scan') result = await engine.scan(m.args[0]);
    else if (m.method === 'confirmStatement') engine.confirmStatement(m.args[0], m.args[1]);
    else if (m.method === 'ignoreFinding') engine.ignoreFinding(m.args[0]);
    else if (m.method === 'excludeFiles') result = engine.excludeFiles(m.args[0]);
    else if (m.method === 'trace') {
      if (tracer) tracer.stop();
      const cmd = m.args[0];
      const valid = typeof cmd === 'string' ? !!cmd.trim() : Array.isArray(cmd) && cmd.length > 0 && cmd.every((a) => typeof a === 'string') && !!cmd[0];
      if (!valid) throw new Error('trace: command must be a non-empty string or argument list');
      // Los eventos de una ejecución sustituida se descartan: no deben cerrar a la que la reemplazó.
      const mine = engine.trace(m.args[0], {
        onUpdate: (data) => tracer === mine && send({ event: 'update', data }),
        onOutput: (data) => tracer === mine && send({ event: 'output', data }),
        onExit: (data) => { if (tracer !== mine) return; tracer = null; send({ event: 'exit', data }); },
      });
      tracer = mine;
      send({ event: 'pid', pid: mine.pid });
    } else throw new Error(`unknown method: ${m.method}`);
    send({ id: m.id, result });
  } catch (e) {
    send({ id: m.id, error: String((e && e.message) || e) });
  }
}
process.on('disconnect', () => { tracer && tracer.stop(); process.exit(0); });
