'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

/** Glob mínimo: ** cruza carpetas, * no, ? un carácter. */
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Como readJson, pero distingue «no existe» de «está dañado», para no sustituir en silencio un archivo ilegible. */
function readJsonState(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { status: 'missing' } : { status: 'invalid', error: String(e.message) }; }
  try { return { status: 'valid', data: JSON.parse(text) }; } catch (e) { return { status: 'invalid', error: String(e.message) }; }
}

/** Aparta un archivo dañado con la fecha en el nombre, para poder recuperarlo. Devuelve la ruta nueva. */
function quarantine(file) {
  const dest = `${file}.danado-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try { fs.renameSync(file, dest); return dest; } catch { return null; }
}

/**
 * Bloqueo breve por archivo para que la CLI y la extensión no escriban a la vez. Un bloqueo de más de 10 s
 * se considera abandonado (un proceso que murió a medias) y se retira.
 */
function withLock(file, fn) {
  const lock = file + '.lock';
  const start = Date.now();
  for (;;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() - start > 5000) throw new Error(t`spectator.json está ocupado por otro proceso; inténtalo de nuevo.`);
      const until = Date.now() + 25; while (Date.now() < until) { /* espera breve */ }
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

const DEFAULT_CONFIG = {
  exclude: [],
  limits: { complexity: 15, complexityFail: 30, functionLines: 80, params: 6, nesting: 5, fileLines: 600, duplicateTokens: 70, duplicateLines: 6 },
  contract: [],
  architecture: [],
  ignore: [],
};

/** Hasta la 0.2 el producto tenía otro nombre: se adoptan su archivo de normas y su carpeta de estado. */
function migrate(root) {
  for (const [old, now] of [['project-' + 'guard.json', 'spectator.json'], ['.project-' + 'guard', '.spectator']]) {
    const a = path.join(root, old), b = path.join(root, now);
    try { if (fs.existsSync(a) && !fs.existsSync(b)) fs.renameSync(a, b); } catch { /* solo lectura: se empieza de cero */ }
  }
}

function loadConfig(root) {
  migrate(root);
  const user = readConfig(root);
  return {
    ...DEFAULT_CONFIG, ...user,
    limits: { ...DEFAULT_CONFIG.limits, ...(user.limits || {}) },
    exists: fs.existsSync(path.join(root, 'spectator.json')),
  };
}

function readConfig(root) {
  let source;
  try { source = fs.readFileSync(path.join(root, 'spectator.json'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  let cfg;
  try { cfg = JSON.parse(source); } catch { throw new Error(t`spectator.json contiene JSON inválido; no se modificó.`); }
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const invalid = () => { throw new Error(t`spectator.json tiene una configuración inválida; no se modificó.`); };
  if (!object(cfg)) invalid();
  for (const key of ['exclude', 'ignore', 'contract', 'architecture']) {
    if (cfg[key] !== undefined && !Array.isArray(cfg[key])) invalid();
  }
  for (const key of ['exclude', 'ignore']) if ((cfg[key] || []).some((v) => typeof v !== 'string')) invalid();
  for (const key of ['contract', 'architecture']) if ((cfg[key] || []).some((v) => !object(v))) invalid();
  for (const c of cfg.contract || []) {
    if (!(typeof c.name === 'string' && c.name || typeof c.match === 'string' && c.match)) invalid();
    for (const key of ['id', 'name', 'match', 'file', 'description']) if (c[key] !== undefined && typeof c[key] !== 'string') invalid();
    if (!['string', 'number', 'boolean'].includes(typeof c.value) || (typeof c.value === 'number' && !Number.isFinite(c.value))) invalid();
    if (c.operator !== undefined && !['=', '==', '===', '!=', '!==', '<', '>', '<=', '>='].includes(c.operator)) invalid();
    if (c.match) { try { new RegExp(c.match); } catch { invalid(); } }
  }
  if (cfg.components !== undefined && (!Array.isArray(cfg.components) || cfg.components.some((c) => !object(c) || typeof c.path !== 'string' || (c.name !== undefined && typeof c.name !== 'string')))) invalid();
  for (const rule of cfg.architecture || []) {
    if (typeof rule.from !== 'string' || typeof rule.deny !== 'string') invalid();
  }
  if (cfg.limits !== undefined && (!object(cfg.limits) || Object.values(cfg.limits).some((v) => !Number.isSafeInteger(v) || v <= 0))) invalid();
  return cfg;
}

/** Modifica spectator.json conservando lo que el usuario ya tenga. */
function updateConfig(root, mutate) {
  // Leer, cambiar y escribir con el archivo bloqueado: dos cambios simultáneos (CLI y extensión) no se pisan.
  const file = path.join(root, 'spectator.json');
  withLock(file, () => {
    const cfg = readConfig(root);
    mutate(cfg);
    writeJson(file, cfg);
  });
}

function stateDir(root) {
  const dir = path.join(root, '.spectator');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  }
  return dir;
}

/** Ruta de `target` relativa a `root`, o null si queda fuera. Compara carpetas completas: «/a/proyecto-otro» no está dentro de «/a/proyecto». */
/** Termina un proceso y sus hijos: en Windows con taskkill /T, en el resto a todo su grupo (se lanzan con detached). */
function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return;
  try {
    if (process.platform === 'win32') require('child_process').spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, signal);
  } catch { /* ya terminó */ }
}

function relativeInside(root, target) {
  const rel = path.relative(root, target);
  return !rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) ? null : rel;
}

module.exports = { readJsonState, quarantine, withLock, killTree, relativeInside, hash, globToRegex, readJson, writeJson, loadConfig, updateConfig, stateDir, DEFAULT_CONFIG };
