'use strict';
const fs = require('fs');
const path = require('path');
const { globToRegex } = require('./util');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', '.next', '.nuxt',
  '.cache', '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.spectator', '.project-' + 'guard', '.codegraph', 'obj',
  'Pods', 'DerivedData', 'Carthage', 'xcuserdata', '.gradle', '.dart_tool', 'bower_components', '.turbo', '.parcel-cache', 'site-packages', '.tox', '.mypy_cache',
]);

const LANG_BY_EXT = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.py': 'python', '.go': 'go', '.java': 'java', '.cs': 'c_sharp', '.rs': 'rust', '.php': 'php', '.rb': 'ruby',
  '.swift': 'swift', '.kt': 'kotlin', '.kts': 'kotlin',
  // Archivos con <script> incrustado: se analiza solo el código de los scripts.
  '.vue': 'javascript', '.svelte': 'javascript', '.html': 'javascript', '.htm': 'javascript',
};

// Archivos de texto sin gramática: solo pasan por los escáneres de secretos.
const TEXT_EXT = new Set(['.json', '.yml', '.yaml', '.env', '.toml', '.ini', '.cfg', '.conf', '.properties', '.xml', '.sh', '.tf', '.txt', '.md']);
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'go.sum']);
const MAX_BYTES = 400 * 1024;
const EMBEDDED = new Set(['.vue', '.svelte', '.html', '.htm']);

/** Deja solo el contenido de los <script>, conservando posiciones y saltos de línea. */
function scriptOnly(src) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  let out = '', last = 0, ts = false;
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m; (m = re.exec(src));) {
    const start = m.index + m[0].indexOf('>') + 1;
    const isCode = !/\bsrc\s*=/.test(m[1]) && !/type\s*=\s*["'](?!module|text\/javascript|application\/javascript)/i.test(m[1]);
    out += blank(src.slice(last, start)) + (isCode ? m[2] : blank(m[2]));
    last = start + m[2].length;
    if (isCode && /lang\s*=\s*["']?(ts|typescript)/i.test(m[1])) ts = true;
  }
  return { source: out + blank(src.slice(last)), ts };
}

const TEST_RE = /(^|\/)(tests?|__tests__|spec|specs|e2e|\w*(UI)?Tests)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb)$|Tests?\.(java|cs|swift|kt)$|_spec\.rb$/;
const isTestFile = (rel) => TEST_RE.test(rel);

/**
 * Recorre el proyecto. Devuelve [{rel, abs, lang, size, mtime}] con rutas POSIX relativas.
 * `truncated` avisa si se alcanzó maxFiles, para no presentar un análisis parcial como completo.
 */
function listFiles(root, config, maxFiles = 5000) {
  const excludes = (config.exclude || []).map(globToRegex);
  const out = [];
  const skipped = [];
  let truncated = false;
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true }); } catch { skipped.push({ file: relDir || '.', reason: 'unreadable' }); continue; }
    for (const e of entries) {
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
        if (excludes.some((r) => r.test(rel) || r.test(rel + '/'))) continue;
        stack.push(rel);
        continue;
      }
      if (!e.isFile() || SKIP_FILES.has(e.name)) continue;
      const ext = path.extname(e.name).toLowerCase();
      const lang = LANG_BY_EXT[ext];
      const isEnv = e.name === '.env' || e.name.startsWith('.env.');
      if (!lang && !TEXT_EXT.has(ext) && !isEnv) continue;
      if (/\.min\.(js|css)$/.test(e.name) || /\.d\.[cm]?ts$/.test(e.name) || /lock\.json$/.test(e.name)) continue;
      if (excludes.some((r) => r.test(rel))) continue;
      let st;
      try { st = fs.statSync(path.join(root, rel)); } catch { skipped.push({ file: rel, reason: 'unreadable' }); continue; }
      if (st.size > MAX_BYTES) { skipped.push({ file: rel, reason: 'size-limit' }); continue; }
      if (out.length >= maxFiles) { truncated = true; break; }
      out.push({ rel, abs: path.join(root, rel), embedded: EMBEDDED.has(ext), lang: lang || null, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs, isTest: isTestFile(rel) });
    }
    if (truncated) break;
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return { files: out, truncated, skipped };
}

module.exports = { listFiles, isTestFile, scriptOnly, LANG_BY_EXT };
