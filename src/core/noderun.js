'use strict';
// Modo en vivo para Node/Express: arranca la aplicación (npm start o node <archivo>) con un puerto libre, espera a
// que abra un puerto, sondea la API y explica lo que falla: 500 en vez de 404, datos sin validar, cambios que no se
// guardan, peticiones que se quedan colgadas y peticiones que tumban el proceso (que se vuelve a arrancar para seguir).
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { t } = require('./i18n');
const { hash } = require('./util');
const { isExpressProject, indexExpress, readPkg, deps } = require('./express');

const MISSING_ID = 999999;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const HANG_MS = 5000;
const REAL_DB = ['mongoose', 'mongodb', 'pg', 'mysql', 'mysql2', 'mariadb', 'sequelize', 'typeorm', 'prisma', '@prisma/client', 'knex', 'redis', 'ioredis', 'mssql', 'oracledb'];
const DB_PORTS = { mongodb: 27017, postgres: 5432, postgresql: 5432, mysql: 3306, mariadb: 3306, redis: 6379, mssql: 1433 };

function which(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter).concat(['/usr/local/bin', '/opt/homebrew/bin'])) {
    const p = path.join(dir, process.platform === 'win32' ? cmd + '.cmd' : cmd);
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

function detectNode(root) {
  if (!isExpressProject(root)) return null;
  const pkg = readPkg(root);
  const scripts = pkg.scripts || {};
  const npm = which('npm'), node = which('node');
  if (scripts.start && npm) return { kind: 'node-express', exe: npm, args: ['start'], shown: 'npm start' };
  if (scripts.dev && npm) return { kind: 'node-express', exe: npm, args: ['run', 'dev'], shown: 'npm run dev' };
  const main = [pkg.main, 'server.js', 'app.js', 'index.js', 'src/server.js', 'src/app.js', 'src/index.js'].find((f) => f && fs.existsSync(path.join(root, f)));
  if (main && node) return { kind: 'node-express', exe: node, args: [main], shown: 'node ' + main };
  return { kind: 'node-express', exe: null };
}

/** Variables de .env (solo nombres y valores, sin interpretar). */
function readDotenv(root) {
  const out = {}, where = {};
  for (const f of ['.env', '.env.local', '.env.development']) {
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      const m = /^\s*(?:export\s+)?([\w.]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#') && !(m[1] in out)) { out[m[1]] = m[2].replace(/^["']|["']$/g, ''); where[m[1]] = { file: f, line: i + 1 }; }
    });
  }
  return { values: out, where };
}

const reachable = (host, port, ms = 1200) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.setTimeout(ms, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

/** Configuración que el proyecto necesita y no tiene: dependencias sin instalar, variables, base de datos. */
async function nodeConfigNeeds(root, idx) {
  const needs = [];
  const pkg = idx.pkg || {};
  const env = readDotenv(root);
  const hasDotenv = !!deps(pkg).dotenv || fs.existsSync(path.join(root, '.env'));
  const envFile = fs.existsSync(path.join(root, '.env')) ? '.env' : fs.existsSync(path.join(root, '.env.example')) ? '.env.example' : null;
  if (!fs.existsSync(path.join(root, 'node_modules'))) needs.push({ kind: 'deps', key: 'node_modules', what: 'npm install', file: 'package.json', line: 1, proven: true });
  const known = (k) => k in env.values || process.env[k] !== undefined;
  // process.env.X sin valor por defecto (sin || ni ?? en la misma expresión).
  const seen = new Set();
  for (const f of idx.files) {
    f.src.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/process\.env\.(\w+)|process\.env\[\s*['"](\w+)['"]\s*\]/g)) {
        const name = m[1] || m[2];
        if (seen.has(name) || /^(NODE_ENV|PORT|HOST|DEBUG|CI|npm_\w+)$/.test(name) || known(name)) continue;
        const rest = line.slice(m.index + m[0].length);
        if (/^\s*(\|\||\?\?)/.test(rest)) continue;
        seen.add(name);
        needs.push({ kind: 'env', key: name, env: name, what: name, file: f.rel, line: i + 1, envFile: hasDotenv ? envFile || '.env' : null });
      }
    });
  }
  // Base de datos o servicios en URLs de .env que no responden.
  for (const [key, value] of Object.entries(env.values)) {
    const m = /^(mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|mssql):\/\/(?:[^@/]*@)?([^:/?,]+)(?::(\d+))?/.exec(value);
    if (!m || m[1].endsWith('+srv')) continue;
    const port = Number(m[3]) || DB_PORTS[m[1]];
    if (port && !(await reachable(m[2], port))) needs.push({ kind: 'db', key, env: key, what: value, host: `${m[2]}:${port}`, ...env.where[key] });
  }
  const dbDeps = REAL_DB.filter((d) => deps(pkg)[d]);
  const anyUrl = Object.values(env.values).some((v) => /:\/\//.test(v)) || /:\/\/[^'"`]*(mongo|postgres|mysql|redis)/i.test(idx.files.map((f) => f.src).join('\n'));
  if (dbDeps.length && !anyUrl && !needs.some((n) => n.kind === 'env' && /DB|DATABASE|MONGO|POSTGRES|MYSQL|REDIS/i.test(n.key))) {
    needs.push({ kind: 'db', key: 'DATABASE_URL', env: 'DATABASE_URL', what: dbDeps.join(', '), file: envFile || '.env', line: 1, add: true });
  }
  return needs;
}

/**
 * @param opts {root, allowWrites, onState(state), onFinding(list)}
 * @returns {{stop, reprobe, state}}
 */
function startNodeLive(opts) {
  const { root } = opts;
  const project = detectNode(root);
  const idx = indexExpress(root);
  const pkg = idx.pkg || {};
  const dbDeps = REAL_DB.filter((d) => deps(pkg)[d]);
  const env0 = readDotenv(root).values;
  const state = {
    kind: 'node-express', status: 'starting', command: project && project.shown || '', pid: null, startedAt: new Date().toISOString(), readyMs: null,
    port: null, configuredPort: Number(env0.PORT) || 3000, contextPath: '',
    ports: [], connections: [], datasource: Object.values(env0).find((v) => /^(mongodb|postgres|mysql|mariadb|redis)/.test(v)) || (dbDeps.length ? dbDeps.join(', ') : null), h2Console: null,
    endpoints: idx.endpoints.map((e) => ({ method: e.method, path: e.path, file: e.file, line: e.line, source: 'código' })), discovery: 'código',
    requests: [], findings: [], output: '', error: null, writes: false, probing: false, restarts: 0,
  };
  const lines = [];
  let child = null, stopped = false, exited = false, lastEmit = 0, emitTimer = null, readyWait = null;
  const findings = new Map();
  const needs = new Map();

  const emit = (now) => {
    const send = () => { lastEmit = Date.now(); emitTimer = null; opts.onState && opts.onState(snapshot()); };
    if (now || Date.now() - lastEmit > 300) { clearTimeout(emitTimer); send(); } else if (!emitTimer) emitTimer = setTimeout(send, 300);
  };
  const snapshot = () => ({ ...state, findings: [...findings.values()], output: lines.slice(-400).join('\n') });
  const addFinding = (f) => {
    f.id = f.fingerprint = hash(['live', f.rule, f.file, f.key].join('|'));
    delete f.key;
    findings.set(f.id, f);
    opts.onFinding && opts.onFinding([...findings.values()]);
    emit();
  };
  const F = (category, rule, severity, file, line, key, o) => ({
    category, rule, severity, file, line: line || 1, key, confidence: 95, deterministic: true, source: 'spectator-live', live: true, evidence: [], isNew: true, ...o,
  });

  function addNeed(n) {
    const key = n.kind + ':' + n.key;
    const prev = needs.get(key);
    if (prev && (prev.proven || !n.proven)) return;
    needs.set(key, n);
    state.needs = [...needs.values()];
    const WHAT = { deps: t`instalar las dependencias (npm install)`, db: t`una base de datos accesible`, env: t`el valor de «${n.what}»` };
    const WHY = {
      deps: t`No existe la carpeta node_modules: las librerías del proyecto no están instaladas.`,
      db: n.host ? t`«${n.key}» apunta a ${n.what}, pero no responde en ${n.host}.` : t`El proyecto usa ${n.what}, pero no dice a qué base de datos conectarse.`,
      env: t`El código lee process.env.${n.what} sin valor por defecto y esa variable no está definida.`,
    };
    const place = n.kind === 'deps' ? t`Ejecuta npm install en la carpeta del proyecto.`
      : n.kind === 'env' ? (n.envFile ? t`Añade ${n.key}=… a ${n.envFile} (se usa en ${n.file}, línea ${n.line}).` : t`Define la variable de entorno ${n.key} (se usa en ${n.file}, línea ${n.line}).`)
      : n.host ? t`Arranca la base de datos o corrige la dirección en ${n.file}, línea ${n.line} (${n.key}).` : n.add ? t`Añade ${n.key}=… a ${n.file}.` : t`Escríbelo en ${n.file}, línea ${n.line} (${n.key}).`;
    addFinding(F('context', 'live-needs-config', 'human', n.file, n.line, key, {
      confidence: n.proven ? 99 : 80,
      title: t`Falta configuración: ${WHAT[n.kind]}`,
      why: WHY[n.kind] + ' ' + (n.proven ? t`Por eso la aplicación no arrancó.` : t`Puede que la aplicación no arranque.`) + ' ' + t`Mientras falte, Spectator solo puede hacer el análisis estático: no puede ejecutar la aplicación ni probar su API.`,
      action: place + (n.kind === 'env' ? ' ' + t`En VS Code también sirve launch.json; en IntelliJ/WebStorm, Run Configuration → Environment variables.` : ''),
      tech: n.key + (n.what && n.what !== n.key ? ' = ' + n.what : ''), evidence: [n.proven ? t`Lo confirma el log de arranque` : t`Comprobado antes de arrancar`, ...(n.host ? [t`Sin respuesta en ${n.host}`] : [])],
    }));
  }

  if (!project || !project.exe) {
    state.status = 'failed';
    state.error = !project ? t`No es un proyecto Express (no hay package.json con express).` : t`No se encontró cómo arrancarlo: falta un script start o dev en package.json, o node/npm en el PATH.`;
    setImmediate(() => emit(true));
    return { stop() {}, reprobe() {}, state: snapshot };
  }

  /** Archivo y línea del primer marco de la pila que pertenece al proyecto. */
  function projectFrame(chunk) {
    let realRoot = root;
    try { realRoot = fs.realpathSync(root); } catch { /* tal cual */ }
    for (const l of chunk) {
      const m = /(?:\(|at |^)((?:file:\/\/)?\/[^():\s]+\.(?:c|m)?(?:j|t)s):(\d+)(?::\d+)?/.exec(l);
      if (!m) continue;
      const abs = m[1].replace(/^file:\/\//, '');
      if (abs.includes('/node_modules/')) continue;
      for (const base of [root, realRoot]) {
        const rel = path.relative(base, abs);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return { file: rel.split(path.sep).join('/'), line: Number(m[2]), frame: l.trim() };
      }
    }
    return null;
  }
  const errorLine = (log) => (log.find((l) => /^\s*(\w*Error|Unhandled|TypeError|ReferenceError|SyntaxError)\b|Error:/.test(l)) || '').trim().slice(0, 240);
  const EXPLAIN = [
    [/Cannot read propert(y|ies) of (undefined|null)|Cannot destructure|is not a function|undefined is not/, () => t`El código usa un valor que no existe (undefined o null): normalmente un registro que no se encontró y nadie comprobó.`],
    [/Cannot find module '(\.[^']*)'/, () => t`Un require/import apunta a un archivo del proyecto que no existe.`],
    [/Cannot find module|ERR_MODULE_NOT_FOUND/, () => t`Falta una librería: no está instalada (npm install) o no está en package.json.`],
    [/EADDRINUSE/, () => t`El puerto ya lo está usando otro programa (¿la misma aplicación abierta en otra terminal?).`],
    [/ECONNREFUSED|MongooseServerSelectionError|getaddrinfo ENOTFOUND/, () => t`La aplicación no pudo conectarse a la base de datos o a otro servicio: no está en marcha o la dirección no es correcta.`],
    [/SyntaxError/, () => t`Hay un error de sintaxis: Node no puede cargar el archivo.`],
    [/UnhandledPromiseRejection|unhandledRejection|triggerUncaughtException/, () => t`Una promesa falló y nadie capturó el error: Node termina el proceso.`],
  ];
  const explain = (text) => { for (const [re, fn] of EXPLAIN) if (re.test(text)) return fn(); return null; };

  // ── Arranque
  async function launch() {
    exited = false;
    lines.length = 0;
    state.status = 'starting'; state.phase = t`arrancando Node`; state.port = null; state.ports = [];
    const port = await freePort();
    state.assignedPort = port;
    if (stopped) return;
    const env = { ...process.env, PORT: String(port), FORCE_COLOR: '0', NO_COLOR: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(project.exe, project.args, { cwd: root, env, detached: process.platform !== 'win32' });
    state.pid = child.pid;
    let buf = '';
    const onData = (d) => {
      buf += String(d).replace(ANSI, '');
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const l of parts) lines.push(l.replace(/\r$/, ''));
      if (lines.length > 20000) lines.splice(0, 5000);
      emit();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { state.status = 'failed'; state.error = String(e.message || e); emit(true); });
    child.on('exit', (code, signal) => {
      exited = true;
      if (buf) lines.push(buf);
      if (stopped) { state.status = 'stopped'; emit(true); return; }
      const wasRunning = state.status === 'running';
      state.status = wasRunning ? 'exited' : 'failed'; state.exitCode = code; state.signal = signal; state.phase = null;
      if (!wasRunning) analyzeFailure(code);
      if (readyWait) readyWait(false);
      emit(true);
    });
    // Listo cuando el grupo de procesos abre un puerto TCP (o el log lo dice).
    const started = Date.now();
    const ok = await new Promise((resolve) => {
      readyWait = resolve;
      const tick = async () => {
        if (exited || stopped) return resolve(false);
        await inspectSockets();
        const http = state.ports.map((p) => Number(p.split(':').pop())).filter((p) => p !== 9229);
        if (http.length) { state.port = http.includes(port) ? port : http[0]; return resolve(true); }
        if (Date.now() - started > 60000) return resolve(false);
        setTimeout(tick, 400);
      };
      setTimeout(tick, 300);
    });
    readyWait = null;
    if (!ok) {
      if (!exited && !stopped) { state.status = 'failed'; state.error = t`La aplicación sigue en marcha pero no abrió ningún puerto en 60 s.`; emit(true); }
      return false;
    }
    if (state.port !== port) state.portNote = t`La aplicación no usa process.env.PORT: escucha en el ${state.port}.`;
    state.status = 'running'; state.phase = null;
    state.readyMs = Date.now() - started;
    emit(true);
    return true;
  }

  function inspectSockets() {
    if (process.platform === 'win32' || !child) return Promise.resolve();
    return new Promise((resolve) => {
      execFile('lsof', ['-nP', '-a', '-g', String(child.pid), '-iTCP'], { timeout: 5000 }, (_err, out) => {
        const listen = new Set(), conns = new Set(), own = new Set();
        for (const line of String(out || '').split('\n').slice(1)) {
          const m = /TCP (\S+?)(?:->(\S+))? \((\w+)\)/.exec(line);
          if (!m) continue;
          own.add(m[1]);
          if (m[3] === 'LISTEN') listen.add(m[1]);
          else if (m[3] === 'ESTABLISHED' && m[2]) conns.add(m[2]);
        }
        state.ports = [...listen];
        state.connections = [...conns].filter((c) => !own.has(c) && !(state.port && c.endsWith(':' + state.port)));
        resolve();
      });
    });
  }

  function analyzeFailure(code) {
    const text = lines.join('\n');
    const errIdx = lines.findIndex((l) => /^\s*(\w*Error|Error)\b[:\s]|Error \[ERR_|Unhandled/.test(l));
    const cause = (errIdx >= 0 ? lines[errIdx] : lines.filter((l) => l.trim()).pop() || t`la aplicación terminó sin arrancar`).trim();
    state.error = code === 0 && errIdx < 0 ? t`El programa terminó (código 0) sin abrir ningún puerto.` : cause;
    if (/Cannot find module '(?!\.)([^']+)'|ERR_MODULE_NOT_FOUND/.test(text) && !fs.existsSync(path.join(root, 'node_modules'))) addNeed({ kind: 'deps', key: 'node_modules', what: 'npm install', file: 'package.json', line: 1, proven: true });
    const missingEnv = /(?:process\.env\.|variable de entorno |env(?:ironment)? variable |missing |required )(\w*[A-Z_]{3,}\w*)/i.exec(text);
    if (missingEnv) for (const n of needs.values()) if (n.kind === 'env' && n.key === missingEnv[1]) addNeed({ ...n, proven: true });
    if (/ECONNREFUSED|MongooseServerSelectionError|ENOTFOUND/.test(text)) for (const n of needs.values()) if (n.kind === 'db') addNeed({ ...n, proven: true });
    // SyntaxError: Node imprime «/ruta/archivo.js:12» en la primera línea.
    const fr = projectFrame(lines.slice(Math.max(0, errIdx - 6)));
    const modRel = /Cannot find module '(\.[^']*)'/.exec(text);
    addFinding(F('correctness', 'live-startup-failure', 'fail', fr ? fr.file : 'package.json', fr ? fr.line : 1, cause.slice(0, 120), {
      confidence: 99, title: t`La aplicación no arranca`,
      why: (explain(text) || t`El proceso terminó antes de abrir un puerto.`) + ' ' + t`Nada de esto se ve al escribir el código: solo aparece al ejecutar.`,
      action: modRel ? t`Corregir la ruta «${modRel[1]}» o crear el archivo.` : [...needs.values()].some((n) => n.proven) ? t`Completar la configuración que falta (ver abajo) y volver a arrancar.` : t`Leer el error y corregir el archivo indicado.`,
      tech: cause, evidence: [t`Salida de «${project.shown}»`, ...(fr ? [fr.frame] : [])],
    }));
    state.blockedNote = [...needs.values()].some((n) => n.proven) ? t`La API no se pudo probar: falta configuración (ver abajo). Mientras tanto solo funciona el análisis estático.` : t`La API no se pudo probar porque la aplicación no arrancó. Corrige el error de arranque y vuelve a intentarlo.`;
  }

  // ── Sondeo
  const base = () => `http://127.0.0.1:${state.port}`;
  /** Una petición caída tumba el proceso: se registra, se vuelve a arrancar y el sondeo sigue con lo demás. */
  async function ensureRunning() {
    if (state.status === 'running' && !exited) return true;
    if (stopped || state.restarts >= 3) return false;
    state.restarts++;
    return launch();
  }
  async function request(method, urlPath, body, why) {
    if (!(await ensureRunning())) return { status: null, json: null, text: '', log: [], entry: { method, url: urlPath } };
    const from = lines.length;
    const started = Date.now();
    const entry = { method, url: urlPath, status: null, ms: null, why, at: new Date().toISOString() };
    state.requests.push(entry);
    emit();
    let text = '';
    try {
      const res = await fetch(base() + urlPath, { method, headers: body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(HANG_MS) });
      text = await res.text();
      entry.status = res.status;
    } catch (e) { entry.error = /timeout|aborted/i.test(String(e && (e.name + e.message))) ? 'timeout' : String(e.message || e); }
    entry.ms = Date.now() - started;
    await new Promise((r) => setTimeout(r, entry.status >= 500 || entry.error ? 500 : 60));
    const log = lines.slice(from);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* no es JSON */ }
    const err = errorLine(log);
    if (err) entry.log = err;
    const crashed = exited && !stopped;
    if (crashed) entry.note = t`el proceso se cayó`;
    emit();
    return { status: entry.status, json, text, log, entry, crashed, hang: entry.error === 'timeout' };
  }

  const firstIds = (json) => {
    const out = [];
    const walk = (j) => { if (!j || typeof j !== 'object') return; if (!Array.isArray(j) && (typeof j.id === 'number' || typeof j.id === 'string' || typeof j._id === 'string')) out.push(j.id ?? j._id); for (const v of Object.values(j)) if (typeof v === 'object') walk(v); };
    walk(json);
    return out;
  };
  const findById = (json, id) => {
    if (!json || typeof json !== 'object') return null;
    if (!Array.isArray(json) && String(json.id ?? json._id) === String(id)) return json;
    for (const v of Object.values(json)) { const r = findById(v, id); if (r) return r; }
    return null;
  };
  const sample = (name, tag) => (/(precio|price|cantidad|qty|quantity|stock|edad|age|total|amount|importe|count|num)/i.test(name) ? 7 : /(^id$|Id$|_id$)/.test(name) ? 1 : /(email|correo)/i.test(name) ? 'spectator@example.com' : /(fecha|date|At$)/i.test(name) ? '2030-06-15T10:00:00Z' : `Spectator ${tag}`);
  const withId = (p, id) => p.replace(/:\w+\??$/, String(id)).replace(/:\w+\??/g, '1');
  const blankOf = (fields) => Object.fromEntries(fields.map((f) => [f, '']));

  function locate(ep, res) {
    const fr = res && projectFrame(res.log);
    return fr ? { file: fr.file, line: fr.line, frame: fr.frame } : { file: ep.file, line: ep.line };
  }
  const handlerRef = (ep) => ({ file: ep.file, line: ep.line });

  function crashOrHang(ep, res) {
    if (res.crashed) {
      const loc = locate(ep, res);
      addFinding(F('correctness', 'live-crash', 'fail', loc.file, loc.line, ep.handler, {
        title: t`${res.entry.method} ${ep.path} tumba el servidor`,
        why: (explain(res.log.join('\n')) || t`Un error sin capturar terminó el proceso de Node.`) + ' ' + t`Mientras nadie lo reinicie, todas las demás rutas dejan de responder. Spectator lo volvió a arrancar para seguir probando.`,
        action: ep.async ? t`Capturar el error del handler async (try/catch + next(err), express-async-errors o Express 5).` : t`Capturar el error y responder con un código claro (400, 404 o 500) en vez de dejar caer el proceso.`,
        tech: errorLine(res.log) || t`el proceso terminó durante la petición`, evidence: [t`Petición real: ${res.entry.method} ${res.entry.url}`, ...(loc.frame ? [loc.frame] : [])], related: [handlerRef(ep)],
      }));
      return true;
    }
    if (res.hang) {
      addFinding(F('correctness', 'live-hang', 'fail', ep.file, ep.line, ep.handler, {
        title: t`${res.entry.method} ${ep.path} no responde nunca`,
        why: t`Spectator esperó ${HANG_MS / 1000} s y no llegó respuesta. Suele ser un error dentro de un handler async que nadie captura, o un camino del código que no llama a res.json/res.send.`,
        action: t`Asegurar que todos los caminos responden y capturar los errores con try/catch + next(err).`,
        tech: errorLine(res.log) || t`sin respuesta en ${HANG_MS} ms`, evidence: [t`Petición real: ${res.entry.method} ${res.entry.url}`], related: [handlerRef(ep)],
      }));
      return true;
    }
    return false;
  }
  function serverError(ep, res) {
    if (crashOrHang(ep, res)) return;
    const loc = locate(ep, res);
    addFinding(F('correctness', 'live-server-error', 'fail', loc.file, loc.line, ep.handler, {
      title: t`${ep.handler} falla con ${res.status} en una petición normal`,
      why: explain(res.log.join('\n')) || t`El servidor lanzó una excepción que nadie manejó.`,
      action: t`Leer el error y corregir el archivo indicado.`,
      tech: errorLine(res.log) || `HTTP ${res.status}`, evidence: [t`Petición real: ${res.entry.method} ${res.entry.url} → ${res.status} (${res.entry.ms} ms)`, ...(loc.frame ? [loc.frame] : [])], related: [handlerRef(ep)],
    }));
  }
  function missing(ep, res, method) {
    if (crashOrHang(ep, res)) return;
    const loc = locate(ep, res);
    const empty = res.status >= 200 && res.status < 300;
    addFinding(F('correctness', empty ? 'live-missing-200' : 'live-500-not-404', 'fail', loc.file, loc.line, method + ' ' + ep.handler, {
      title: empty ? t`${method} ${ep.path} con un id que no existe responde ${res.status} en vez de 404` : t`${method} ${ep.path} con un id que no existe responde ${res.status} en vez de 404`,
      why: (empty ? t`La API contesta como si todo fuera bien, pero no hay nada: el cliente no puede distinguir «no existe» de «existe y está vacío».` : (explain(res.log.join('\n')) || t`Se lanzó un error que nadie convirtió en una respuesta clara.`) + ' ' + t`El cliente recibe «error interno del servidor» cuando lo correcto es «no encontrado».`),
      action: t`Comprobar si el registro existe y responder res.status(404).json({ error: '…' }) cuando no.`,
      tech: errorLine(res.log) || `HTTP ${res.status}`, evidence: [t`Petición real: ${method} ${res.entry.url} → ${res.status} (${res.entry.ms} ms)`, ...(loc.frame ? [loc.frame] : [])], related: [handlerRef(ep)],
    }));
  }

  async function probe() {
    if (state.probing || state.status !== 'running') return;
    state.probing = true;
    state.requests = [];
    state.writes = !!opts.allowWrites || !dbDeps.length;
    emit(true);
    const eps = idx.endpoints;
    const ids = new Map(), items = new Map();
    const collection = (p) => p.replace(/\/:\w+\??$/, '');
    try {
      // 1) GET sin parámetros en la ruta.
      for (const ep of eps.filter((e) => e.method === 'GET' && !e.path.includes(':'))) {
        const res = await request('GET', ep.path, undefined, t`GET normal`);
        if (res.status >= 200 && res.status < 300) {
          const found = firstIds(res.json);
          if (found.length) { ids.set(ep.path, found[0]); items.set(ep.path, findById(res.json, found[0])); }
        } else if (res.status >= 500 || res.crashed || res.hang) serverError(ep, res);
      }
      // 2) GET /:id con un id que existe y con uno que no.
      for (const ep of eps.filter((e) => e.method === 'GET' && /:\w+\??$/.test(e.path))) {
        const id = ids.get(collection(ep.path)) ?? 1;
        const ok = await request('GET', withId(ep.path, id), undefined, t`GET de un id que existe`);
        if (ok.status >= 500 || ok.crashed || ok.hang) serverError(ep, ok);
        const miss = await request('GET', withId(ep.path, MISSING_ID), undefined, t`GET de un id que no existe`);
        if (miss.status >= 500 || miss.crashed || miss.hang) missing(ep, miss, 'GET');
        else if (miss.status >= 200 && miss.status < 300 && (miss.json == null || (typeof miss.json === 'object' && !Object.keys(miss.json).length))) missing(ep, miss, 'GET');
      }
      // 3) DELETE de un id que no existe.
      for (const ep of eps.filter((e) => e.method === 'DELETE' && /:\w+\??$/.test(e.path))) {
        const p = withId(ep.path, MISSING_ID);
        const res = await request('DELETE', p, undefined, t`DELETE de un id que no existe`);
        if (res.status >= 200 && res.status < 300) {
          addFinding(F('correctness', 'live-delete-not-404', 'fail', ep.file, ep.line, ep.handler, {
            title: t`DELETE ${ep.path} responde ${res.status} aunque el registro no existe`,
            why: t`Spectator borró el id ${MISSING_ID}, que no existe, y la API contestó «${res.status} borrado con éxito». El cliente cree que borró algo.`,
            action: t`Comprobar si el registro existe y responder 404 si no.`,
            tech: t`DELETE ${p} → ${res.status} en ${res.entry.ms} ms`, evidence: [t`Petición real a ${base()}${p}`], related: [handlerRef(ep)],
          }));
        } else if (res.status >= 500 || res.crashed || res.hang) missing(ep, res, 'DELETE');
      }
      if (!state.writes) {
        state.writesNote = t`No se enviaron POST ni PUT: el proyecto usa una base de datos real (${dbDeps.join(', ')}). Actívalo con spectator.live.allowWrites si es una base de pruebas.`;
        emit();
      } else {
        // 4) POST con campos en blanco: debería rechazarse con 400.
        for (const ep of eps.filter((e) => e.method === 'POST' && !e.path.includes(':'))) {
          const sampleItem = items.get(ep.path);
          const fields = ep.fields.length ? ep.fields : sampleItem ? Object.keys(sampleItem).filter((k) => k !== 'id' && k !== '_id') : [];
          if (!fields.length && !/\breq\.body\b/.test(ep.body)) continue;
          const blank = blankOf(fields);
          const res = await request('POST', ep.path, blank, t`POST con campos en blanco`);
          if (res.status >= 200 && res.status < 300) {
            addFinding(F('correctness', 'live-no-validation', 'fail', ep.file, ep.line, ep.handler, {
              title: t`POST ${ep.path} acepta datos en blanco (respondió ${res.status})`,
              why: t`No hay reglas de validación que rechacen estos datos.` + ' ' + t`Spectator envió ${JSON.stringify(blank)} y se guardó igualmente.`,
              action: t`Validar el cuerpo (zod, joi, express-validator o un if) y responder 400 si no es válido.`,
              tech: t`POST ${ep.path} → ${res.status} con cuerpo en blanco`, evidence: [t`Petición real a ${base()}${ep.path}`, t`Respuesta: ${res.text.slice(0, 200)}`], related: [handlerRef(ep)],
            }));
          } else if (res.status >= 500 || res.crashed || res.hang) serverError(ep, res);
        }
        // 5) PUT/PATCH con datos válidos y relectura.
        for (const ep of eps.filter((e) => (e.method === 'PUT' || e.method === 'PATCH') && /:\w+\??$/.test(e.path))) {
          const coll = collection(ep.path);
          const id = ids.get(coll);
          const current = items.get(coll);
          if (id == null || !current) continue;
          const tag = String(Date.now() % 100000);
          const body = {};
          for (const [k, v] of Object.entries(current)) if (k !== 'id' && k !== '_id') body[k] = typeof v === 'string' ? `Spectator ${tag}` : v;
          for (const f of ep.fields) if (!(f in body)) body[f] = sample(f, tag);
          if (!Object.values(body).some((v) => typeof v === 'string')) continue;
          const p = withId(ep.path, id);
          const res = await request(ep.method, p, body, t`${ep.method} con datos válidos`);
          if (res.status >= 500 || res.crashed || res.hang) { serverError(ep, res); continue; }
          if (!(res.status >= 200 && res.status < 300)) { res.entry.note = t`el sondeo no consiguió datos válidos (${res.status})`; continue; }
          const getOne = eps.find((e) => e.method === 'GET' && e.path === ep.path);
          let after = null, via = '';
          if (getOne) { const g = await request('GET', p, undefined, t`releer tras el cambio`); if (g.status === 200 && g.json) { after = g.json; via = 'GET ' + p; } }
          if (!after && eps.some((e) => e.method === 'GET' && e.path === coll)) { const g = await request('GET', coll, undefined, t`releer tras el cambio`); after = findById(g.json, id); via = 'GET ' + coll; }
          if (!after) { res.entry.note = t`no se pudo releer el registro para comprobar el cambio`; continue; }
          const lost = Object.entries(body).filter(([k, v]) => typeof v === 'string' && k in after && after[k] !== v);
          if (lost.length) {
            addFinding(F('correctness', 'live-update-lost', 'fail', ep.file, ep.line, ep.handler, {
              title: t`${ep.method} ${ep.path} responde ${res.status} pero el cambio no se guarda`,
              why: t`Spectator cambió ${lost.map(([k, v]) => `${k} = «${v}»`).join(', ')} y la API dijo que todo fue bien; al volver a leer el registro (${via}) sigue con ${lost.map(([k]) => `${k} = «${after[k]}»`).join(', ')}. ` + t`Suele pasar al modificar una copia (spread, map) en vez del objeto guardado, o al olvidar guardar en la base de datos (save, await).`,
              action: t`Modificar el registro guardado (o llamar a save/update y esperar con await) antes de responder.`,
              tech: t`${ep.method} ${p} → ${res.status}; relectura con ${via}`, evidence: [t`Cuerpo enviado: ${JSON.stringify(body)}`, t`Valor leído después: ${JSON.stringify(Object.fromEntries(lost.map(([k]) => [k, after[k]])))}`], related: [handlerRef(ep)],
            }));
          } else res.entry.note = t`el cambio quedó guardado`;
        }
      }
    } finally {
      state.probing = false;
      state.probedAt = new Date().toISOString();
      if (!exited) await inspectSockets();
      emit(true);
    }
  }

  (async () => {
    try { for (const n of await nodeConfigNeeds(root, idx)) addNeed(n); } catch { /* la comprobación previa no debe impedir arrancar */ }
    if (await launch()) probe();
  })();

  return {
    state: snapshot,
    reprobe: () => { for (const [k, f] of findings) if (!['live-startup-failure', 'live-needs-config'].includes(f.rule)) findings.delete(k); opts.onFinding && opts.onFinding([...findings.values()]); return probe(); },
    stop() {
      if (stopped) return;
      stopped = true;
      if (!child || exited) { state.status = 'stopped'; emit(true); return; }
      try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']); else process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch { /* ya terminó */ } }
      if (process.platform !== 'win32') setTimeout(() => { if (!exited) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ya terminó */ } } }, 3000).unref();
    },
  };
}

module.exports = { startNodeLive, detectNode, nodeConfigNeeds, readDotenv };
