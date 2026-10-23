// Copia solo las gramáticas que usamos a ./grammars para no empaquetar las ~40 del paquete.
const fs = require('fs');
const path = require('path');
const wanted = ['javascript', 'typescript', 'tsx', 'python', 'go', 'java', 'c_sharp', 'rust', 'php', 'ruby', 'swift', 'kotlin'];
let src;
try { src = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out'); } catch { process.exit(0); }
const dst = path.join(__dirname, '..', 'grammars');
fs.mkdirSync(dst, { recursive: true });
for (const w of wanted) {
  const f = `tree-sitter-${w}.wasm`;
  if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  else console.warn('gramática no encontrada:', f);
}
