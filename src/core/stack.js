'use strict';
// Lee trazas de error (Java/Kotlin, Node.js, Python, C#, Go) y las relaciona con archivos del proyecto,
// para poder decir «el error salió de OrderService.java, línea 42» y abrir ese punto.

const FRAME_PATTERNS = [
  // Java, Kotlin, Scala, Groovy:  at com.tienda.OrderService.crear(OrderService.java:42)
  { re: /\bat\s+([\w$.<>]+)\(([\w$-]+\.(?:java|kt|scala|groovy)):(\d+)\)/g, fn: 1, file: 2, line: 3, byName: true },
  // Node.js:  at crear (/ruta/src/orders.js:10:5)  ·  at /ruta/src/orders.js:10:5
  { re: /\bat\s+(?:(.+?)\s+\()?((?:\/|[A-Za-z]:\\|file:\/\/)[^\s():]+):(\d+):\d+\)?/g, fn: 1, file: 2, line: 3 },
  // Python:  File "/ruta/app/users.py", line 19, in crear
  { re: /File "([^"]+)", line (\d+)(?:, in ([\w<>]+))?/g, file: 1, line: 2, fn: 3 },
  // C#:  at Tienda.Orders.Crear() in /ruta/Orders.cs:line 42
  { re: /\bat\s+([\w.<>`]+)\([^)]*\)\s+in\s+(.+?\.cs):line (\d+)/g, fn: 1, file: 2, line: 3 },
  // Go:  /ruta/main.go:17 +0x1d
  { re: /^\s*((?:\/|[A-Za-z]:\\)[^\s:]+\.go):(\d+)/gm, file: 1, line: 2 },
];

const norm = (p) => p.replace(/^file:\/\//, '').replace(/\\/g, '/');

/**
 * Extrae los marcos de una traza y los asocia a archivos del proyecto.
 * @param text   texto con la traza (cuerpo de una respuesta, líneas de log…)
 * @param files  rutas relativas de los archivos del proyecto
 * @param root   carpeta del proyecto (para rutas absolutas)
 * @returns marcos del proyecto primero, en orden de aparición; como mucho 12
 */
function projectFrames(text, files, root) {
  if (!text) return [];
  const rootN = norm(root || '').replace(/\/$/, '');
  const byBase = new Map();
  for (const rel of files) {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    (byBase.get(base) || byBase.set(base, []).get(base)).push(rel);
  }
  const frames = [];
  for (const p of FRAME_PATTERNS) {
    p.re.lastIndex = 0;
    for (let m; (m = p.re.exec(text));) {
      const raw = norm(m[p.file]), line = Number(m[p.line]), fn = p.fn ? m[p.fn] || null : null;
      let rel = null;
      if (rootN && raw.startsWith(rootN + '/')) rel = raw.slice(rootN.length + 1);
      else if (p.byName) {
        // En Java la traza da el nombre del archivo y el paquete: se elige el archivo cuya carpeta coincide con el paquete.
        const candidates = byBase.get(raw) || [];
        const pkg = fn ? fn.split('.').slice(0, -2).join('/') : '';
        rel = candidates.find((c) => pkg && c.includes(pkg + '/')) || (candidates.length === 1 ? candidates[0] : null);
      } else {
        const tail = files.find((f) => raw.endsWith('/' + f));
        rel = tail || null;
      }
      frames.push({ file: rel, raw, line, fn, index: m.index });
    }
  }
  frames.sort((a, b) => a.index - b.index);
  const seen = new Set();
  const unique = frames.filter((f) => { const k = (f.file || f.raw) + ':' + f.line; if (seen.has(k)) return false; seen.add(k); return true; });
  const mine = unique.filter((f) => f.file && files.includes(f.file));
  return mine.slice(0, 12).map(({ index, ...f }) => f);
}

/** Primera línea útil de un mensaje de error: el tipo de excepción y su texto. */
function errorHeadline(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ex = lines.find((l) => /(?:^|[\s.])[\w$]*(?:Exception|Error)\b(?::|$|\s)/.test(l) && !/^at\s/.test(l));
  return (ex || lines[0] || '').slice(0, 300) || null;
}

module.exports = { projectFrames, errorHeadline };
