'use strict';
// Lee en vivo los archivos de log de tu aplicación (por ejemplo, el de Spring arrancado desde IntelliJ) y avisa
// de cada error con su traza relacionada con archivos del proyecto. Solo lee lo que se añade a partir de ahora.
const fs = require('fs');
const path = require('path');
const { projectFrames, errorHeadline } = require('./stack');
const { mask } = require('./apiwatch');

// Línea que abre un error: nivel ERROR/FATAL/SEVERE, «Exception»/«Error:» o el inicio de una traza de Python.
const START = /\b(?:ERROR|FATAL|SEVERE|CRITICAL)\b|(?:^|[\s.:])[\w$]*(?:Exception|Error)(?::|\s*$)|^Traceback \(most recent call last\)/;
// Líneas que continúan una traza.
const CONT = /^\s+at\s|^\s*Caused by:|^\s*\.\.\. \d+ (?:more|common frames omitted)|^\s+File "|^\s{2,}\S|^[\w$.]+(?:Exception|Error)\b/;

/** Divide texto de log en bloques de error. */
function errorBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (cur && CONT.test(line)) { cur.push(line); continue; }
    if (cur) { blocks.push(cur); cur = null; }
    if (START.test(line)) cur = [line];
  }
  if (cur) blocks.push(cur);
  return blocks.map((b) => b.join('\n'));
}

/**
 * @param {object} o
 * @param {string[]} o.files rutas absolutas de los logs
 * @param {string} o.root carpeta del proyecto
 * @param {() => string[]} o.projectFiles rutas relativas de los archivos del proyecto
 * @param {(event) => void} o.onEvent
 * @returns {{stop: () => void}}
 */
function watchLogs({ files, root, projectFiles = () => [], onEvent = () => {}, interval = 700 }) {
  const state = new Map();
  let seq = 0;
  const flush = (file, text) => {
    for (const block of errorBlocks(text)) {
      const caused = /Caused by:\s*(.+)/g;
      let root_ = null;
      for (let m; (m = caused.exec(block));) root_ = m[1].trim();
      try {
        onEvent({
          type: 'log', id: ++seq, at: new Date().toISOString(), log: path.relative(root, file).split(path.sep).join('/'),
          headline: mask(errorHeadline(block) || '').slice(0, 300), cause: root_ ? mask(root_).slice(0, 300) : null,
          frames: projectFrames(block, projectFiles(), root), text: mask(block).slice(0, 4000),
        });
      } catch { /* el receptor no debe detener la lectura */ }
    }
  };
  const read = (file) => {
    const st = state.get(file);
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < st.offset) { st.offset = 0; st.rest = ''; } // el log se rotó o se vació
    if (size === st.offset) {
      // Sin datos nuevos: lo pendiente se da por completo (una traza termina cuando el log se calla).
      if (st.rest) { flush(file, st.rest); st.rest = ''; }
      return;
    }
    const fd = fs.openSync(file, 'r');
    let chunk;
    try {
      const len = Math.min(size - st.offset, 1024 * 1024);
      chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, size - len);
      st.offset = size;
    } finally { fs.closeSync(fd); }
    const lines = (st.rest + chunk.toString('utf8')).split('\n');
    const partial = lines.pop(); // la última línea puede estar a medio escribir
    // Un bloque de error al final puede seguir creciendo: se guarda hasta la siguiente lectura.
    let keepFrom = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (START.test(lines[i]) && !CONT.test(lines[i])) { keepFrom = i; break; }
      if (!CONT.test(lines[i])) break;
    }
    if (keepFrom > 0) flush(file, lines.slice(0, keepFrom).join('\n'));
    st.rest = [...lines.slice(keepFrom), partial].join('\n');
  };
  for (const file of files) {
    let offset = 0;
    try { offset = fs.statSync(file).size; } catch { /* aún no existe: se lee cuando aparezca */ }
    state.set(file, { offset, rest: '' });
  }
  const timer = setInterval(() => { for (const file of files) read(file); }, interval);
  timer.unref && timer.unref();
  return { stop: () => clearInterval(timer), files: [...files] };
}

module.exports = { watchLogs, errorBlocks };
