'use strict';
// Extrae las claves de traducción (plantillas etiquetadas con t, T o N) del código fuente.
const fs = require('fs');
const path = require('path');
const FILES = ['src/core/detectors.js', 'src/core/textscan.js', 'src/core/adapters.js', 'src/core/index.js', 'src/core/util.js', 'src/core/http-status.js', 'src/core/spring.js', 'src/core/springrun.js', 'src/core/express.js', 'src/core/noderun.js', 'src/core/backend.js', 'src/core/backend-python.js', 'src/core/backend-js.js', 'src/core/backend-django.js', 'src/cli.js', 'src/extension.js', 'media/app.js'];

function readTemplate(src, i) { // i apunta justo después de la comilla invertida inicial
  const parts = [''], exprs = [];
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { parts[parts.length - 1] += src.slice(i, i + 2); i += 2; continue; }
    if (c === '`') return { parts, exprs, end: i + 1 };
    if (c === '$' && src[i + 1] === '{') {
      i += 2;
      const from = i;
      for (let depth = 1; depth > 0; i++) {
        const d = src[i];
        if (d === '\\') i++;
        else if (d === '`') i = readTemplate(src, i + 1).end - 1;
        else if (d === "'" || d === '"') { for (i++; src[i] !== d; i++) if (src[i] === '\\') i++; }
        else if (d === '{') depth++;
        else if (d === '}') depth--;
      }
      exprs.push(src.slice(from, i - 1));
      parts.push('');
      continue;
    }
    parts[parts.length - 1] += c; i++;
  }
  throw new Error('plantilla sin cerrar');
}

function scan(src, file, keys) {
  const re = /(?<![\w$.])(?:t|T|N)`/g;
  for (let m; (m = re.exec(src));) {
    const { parts, exprs, end } = readTemplate(src, m.index + m[0].length);
    const cooked = parts.map((p) => new Function('return `' + p.replace(/\$\{/g, '\\${') + '`')());
    const key = cooked.reduce((a, s, i) => a + '{' + (i - 1) + '}' + s);
    if (!keys.has(key)) keys.set(key, file);
    for (const e of exprs) scan(e, file, keys); // plantillas anidadas dentro de ${…}
    re.lastIndex = end;
  }
}

function extract(root = path.join(__dirname, '..')) {
  const keys = new Map(); // clave -> archivo
  for (const f of FILES) scan(fs.readFileSync(path.join(root, f), 'utf8'), f, keys);
  return keys;
}

module.exports = { extract };
if (require.main === module) {
  const { dictFor } = require('../src/core/i18n');
  const en = dictFor('en');
  const missing = process.argv.includes('--missing');
  for (const [k, f] of extract()) if (!missing || !(k in en)) console.log(JSON.stringify(k));
}
