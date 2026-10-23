'use strict';
// Modo en vivo para Spring Boot: arranca la aplicación, lee su consola, descubre puertos, base de datos y endpoints,
// y sondea la API con peticiones pensadas para destapar errores que compilan pero fallan al ejecutarse.
// Cada hallazgo se lleva al archivo y la línea del controller, del service o de la pila de llamadas del log.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { t } = require('./i18n');
const { hash } = require('./util');
const { isSpringProject, indexSpring, delegate, checkJpql, closest, simpleTypes, hasConstraints } = require('./spring');

const MISSING_ID = 999999;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Cómo arrancar el proyecto: wrapper del proyecto, mvn del PATH o el Maven que descargó algún wrapper en ~/.m2. */
function findMaven(root) {
  const local = path.join(root, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
  if (fs.existsSync(local)) return local;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, process.platform === 'win32' ? 'mvn.cmd' : 'mvn');
    if (dir && fs.existsSync(p)) return p;
  }
  const dists = path.join(os.homedir(), '.m2', 'wrapper', 'dists');
  const found = [];
  try {
    for (const d of fs.readdirSync(dists)) {
      if (!d.startsWith('apache-maven-')) continue;
      for (const h of fs.readdirSync(path.join(dists, d))) {
        for (const inner of fs.readdirSync(path.join(dists, d, h))) {
          const p = path.join(dists, d, h, inner, 'bin', 'mvn');
          if (fs.existsSync(p)) found.push(p);
        }
      }
    }
  } catch { /* sin wrapper */ }
  return found.sort().pop() || null;
}

function detectProject(root) {
  const build = isSpringProject(root);
  if (!build) return null;
  if (build !== 'pom.xml') {
    const gradlew = path.join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    return { kind: 'spring-gradle', build, exe: fs.existsSync(gradlew) ? gradlew : 'gradle', args: ['bootRun', '--console=plain'] };
  }
  const exe = findMaven(root);
  return { kind: 'spring-maven', build, exe, args: ['-B', 'spring-boot:run'] };
}

/** Propiedades simples de application.properties / application.yml (solo lo que hace falta). */
function readConfig(root) {
  const cfg = {};
  // Dónde está cada propiedad (archivo y línea), y en qué archivo conviene añadir las que faltan.
  const where = {};
  let main = null;
  const dir = path.join(root, 'src', 'main', 'resources');
  const relOf = (f) => path.relative(root, path.join(dir, f)).split(path.sep).join('/');
  for (const f of ['application.properties', 'application.yml', 'application.yaml']) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    if (!main) main = { file: relOf(f), line: lines.length + (text.endsWith('\n') ? 0 : 1), yaml: f !== 'application.properties' };
    if (f === 'application.properties') {
      lines.forEach((line, i) => {
        const m = /^\s*([\w.\[\]-]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
        if (m && !line.trim().startsWith('#')) { cfg[m[1]] = m[2]; where[m[1]] = { file: relOf(f), line: i + 1 }; }
      });
    } else {
      const stack = [];
      lines.forEach((line, i) => {
        const m = /^(\s*)([\w.-]+):\s*(.*?)\s*$/.exec(line);
        if (!m || line.trim().startsWith('#')) return;
        const depth = m[1].length;
        while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
        stack.push({ depth, key: m[2] });
        const key = stack.map((x) => x.key).join('.');
        if (m[3]) { cfg[key] = m[3].replace(/^["']|["']$/g, ''); where[key] = { file: relOf(f), line: i + 1 }; }
      });
    }
  }
  Object.defineProperty(cfg, '__where', { value: where });
  Object.defineProperty(cfg, '__main', { value: main || { file: 'src/main/resources/application.properties', line: 1, missing: true } });
  return cfg;
}

const MEMORY_DB = /jdbc:(h2:mem|hsqldb:mem|derby:memory)/;
const DB_PORTS = { postgresql: 5432, mysql: 3306, mariadb: 3306, sqlserver: 1433, oracle: 1521, db2: 50000 };
const reachable = (host, port, ms = 1500) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.setTimeout(ms, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});
const envName = (key) => key.toUpperCase().replace(/[.\-\[\]]/g, '_');
const envSet = (name) => !!(process.env[name] || process.env[envName(name)]);

/**
 * Configuración que el proyecto necesita y no tiene: base de datos real, claves, variables de entorno o servicios.
 * Cada elemento dice dónde escribirlo (archivo y línea) y, si se puede, la variable de entorno equivalente.
 */
async function configNeeds(root, cfg, idx) {
  const needs = [];
  const where = cfg.__where, main = cfg.__main;
  const at = (key) => where[key] || { file: main.file, line: main.line, add: true };
  const known = (k) => k in cfg || envSet(k);
  // Marcadores ${VAR} sin valor por defecto, en la configuración y en @Value del código.
  for (const [key, value] of Object.entries(cfg)) {
    for (const m of String(value).matchAll(/\$\{([^}:]+)(:[^}]*)?\}/g)) {
      if (m[2] !== undefined || known(m[1])) continue;
      needs.push({ kind: 'env', key, env: envName(m[1]), what: m[1], ...at(key) });
    }
  }
  for (const cls of idx.classes.values()) {
    cls.raw.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/@Value\(\s*"\$\{([^}:]+)(:[^}]*)?\}"\s*\)/g)) {
        if (m[2] !== undefined || known(m[1])) continue;
        needs.push({ kind: 'env', key: m[1], env: envName(m[1]), what: m[1], file: cls.rel, line: i + 1, also: at(m[1]) });
      }
    });
  }
  // Base de datos: real y no accesible, o un driver de base real sin URL.
  const url = cfg['spring.datasource.url'];
  let pom = '';
  try { pom = fs.readFileSync(path.join(root, 'pom.xml'), 'utf8'); } catch { try { pom = fs.readFileSync(path.join(root, 'build.gradle'), 'utf8'); } catch { /* sin build */ } }
  const embedded = /\b(h2|hsqldb|derby)\b/i.test(pom);
  if (url && !url.includes('${') && !MEMORY_DB.test(url)) {
    const kind = (/^jdbc:(\w+)/.exec(url) || [])[1];
    const hp = /\/\/([^:/;?,]+)(?::(\d+))?/.exec(url);
    if (hp && DB_PORTS[kind] && !(await reachable(hp[1], Number(hp[2]) || DB_PORTS[kind]))) {
      needs.push({ kind: 'db', key: 'spring.datasource.url', env: 'SPRING_DATASOURCE_URL', what: url, host: hp[1] + ':' + (hp[2] || DB_PORTS[kind]), ...at('spring.datasource.url') });
    }
    const pw = cfg['spring.datasource.password'];
    if (!pw && !envSet('spring.datasource.password')) needs.push({ kind: 'secret', key: 'spring.datasource.password', env: 'SPRING_DATASOURCE_PASSWORD', what: 'spring.datasource.password', ...at('spring.datasource.password') });
  } else if (!url && !embedded && /(postgresql|mysql-connector|mariadb-java-client|mssql-jdbc|ojdbc)/.test(pom) && !envSet('spring.datasource.url')) {
    needs.push({ kind: 'db', key: 'spring.datasource.url', env: 'SPRING_DATASOURCE_URL', what: '', ...at('spring.datasource.url') });
  }
  // Claves vacías o de ejemplo.
  for (const [key, value] of Object.entries(cfg)) {
    if (!/(api[-_.]?key|secret|token|client[-_.]?secret|access[-_.]?key)$/i.test(key)) continue;
    if (value && !/^(changeme|change-me|todo|x{3,}|your[-_]?\w*|<.*>)$/i.test(value)) continue;
    if (envSet(key)) continue;
    needs.push({ kind: 'secret', key, env: envName(key), what: key, ...at(key) });
  }
  // Servicios locales de los que depende (otra API, Redis, Kafka…) y que no responden.
  const own = Number(cfg['server.port']) || 8080;
  for (const [key, value] of Object.entries(cfg)) {
    const m = /^(?:https?|redis|amqp|kafka|mongodb):\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)(?::(\d+))/.exec(String(value)) || (/(bootstrap-servers|redis\.host|rabbitmq\.host)$/.test(key) && /^(localhost|127\.0\.0\.1):(\d+)$/.exec(value));
    if (!m || Number(m[2]) === own) continue;
    if (!(await reachable(m[1], Number(m[2]), 800))) needs.push({ kind: 'service', key, env: envName(key), what: value, host: m[1] + ':' + m[2], ...at(key) });
  }
  return needs;
}

/** Lo que el log de un arranque fallido dice que falta. */
function failureNeeds(text, cfg, idx) {
  const where = cfg.__where, main = cfg.__main;
  const at = (key) => where[key] || { file: main.file, line: main.line, add: true };
  const out = [];
  for (const m of text.matchAll(/Could not resolve placeholder '([^']+)'/g)) {
    const use = [...Object.entries(cfg)].find(([, v]) => String(v).includes('${' + m[1]));
    let loc = use ? at(use[0]) : null;
    if (!loc) for (const cls of idx.classes.values()) { const i = cls.raw.split('\n').findIndex((l) => l.includes('${' + m[1])); if (i !== -1) { loc = { file: cls.rel, line: i + 1, also: at(m[1]) }; break; } }
    out.push({ kind: 'env', key: use ? use[0] : m[1], env: envName(m[1]), what: m[1], proven: true, ...(loc || at(m[1])) });
  }
  if (/Failed to determine a suitable driver class|Failed to configure a DataSource/.test(text)) out.push({ kind: 'db', key: 'spring.datasource.url', env: 'SPRING_DATASOURCE_URL', what: '', proven: true, ...at('spring.datasource.url') });
  else if (/Connection refused|Communications link failure|Connection to \S+ refused|UnknownHostException|Unable to obtain connection|Unable to open JDBC Connection/.test(text) && cfg['spring.datasource.url'] && !MEMORY_DB.test(cfg['spring.datasource.url'])) out.push({ kind: 'db', key: 'spring.datasource.url', env: 'SPRING_DATASOURCE_URL', what: cfg['spring.datasource.url'], proven: true, ...at('spring.datasource.url') });
  const driver = /(?:Failed to load|Cannot load) driver class ([\w.]+)/.exec(text);
  if (driver) {
    let line = 1;
    try { line = fs.readFileSync(path.join(idx.root, 'pom.xml'), 'utf8').split('\n').findIndex((l) => l.includes('<dependencies>')) + 1 || 1; } catch { /* sin pom */ }
    out.push({ kind: 'driver', key: 'pom.xml', what: driver[1], file: 'pom.xml', line, proven: true });
  }
  if (/password authentication failed|Access denied for user|Login failed for user/.test(text)) out.push({ kind: 'secret', key: 'spring.datasource.password', env: 'SPRING_DATASOURCE_PASSWORD', what: 'spring.datasource.password', proven: true, ...at('spring.datasource.password') });
  return out;
}

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

/** Explicaciones en lenguaje sencillo de las excepciones típicas de Spring/JPA. */
const EXPLAIN = [
  [/UnknownPathException|Could not resolve attribute|PathElementException/, () => t`Una consulta JPQL usa un atributo que la Entity no tiene. Spring revisa las @Query al arrancar y se detiene.`],
  [/NoSuchElementException/, () => t`Se llamó a Optional.get() sobre un resultado vacío: el registro no existe y nadie lo convierte en un 404.`],
  [/LazyInitializationException|could not initialize proxy|failed to lazily initialize/, () => t`Se intentó leer una relación LAZY cuando la sesión de la base de datos ya estaba cerrada (normalmente al convertir una Entity a JSON en el controller).`],
  [/HttpMessageNotWritableException|JsonMappingException|InvalidDefinitionException|Infinite recursion/, () => t`Jackson no pudo convertir la respuesta a JSON. Suele pasar al devolver una Entity con relaciones en lugar de un DTO.`],
  [/EmptyResultDataAccessException/, () => t`Se intentó borrar o leer un registro que no existe.`],
  [/DataIntegrityViolationException|ConstraintViolationException/, () => t`La base de datos rechazó los datos: se violó una restricción (NOT NULL, UNIQUE o clave foránea).`],
  [/Failed to load driver class|Cannot load driver class|ClassNotFoundException: \S*Driver/, () => t`Falta el driver JDBC de la base de datos: la dependencia no está en el pom.xml (o en build.gradle).`],
  [/Failed to determine a suitable driver class|Failed to configure a DataSource|Connection refused|Communications link failure|Unable to obtain connection|password authentication failed|Access denied for user/, () => t`La aplicación no pudo conectarse a la base de datos: falta la URL, no está en marcha o las credenciales no son correctas.`],
  [/Could not resolve placeholder/, () => t`La configuración usa una variable que no tiene valor.`],
  [/Port \d+ was already in use|Address already in use/, () => t`El puerto ya lo está usando otro programa (¿la misma aplicación abierta en IntelliJ?).`],
  [/UnsatisfiedDependencyException|NoSuchBeanDefinitionException/, () => t`Spring no encontró un componente que otro necesita: falta una anotación (@Service, @Repository…) o el paquete está fuera del escaneo.`],
  [/BeanCreationException/, () => t`Spring no pudo crear uno de tus componentes al arrancar.`],
];
const explain = (text) => { for (const [re, fn] of EXPLAIN) if (re.test(text)) return fn(); return null; };

/**
 * @param opts {root, allowWrites, onState(state), onFinding(list)}
 * @returns {{stop, reprobe, state}}
 */
function startSpringLive(opts) {
  const { root } = opts;
  const project = detectProject(root);
  const idx = indexSpring(root);
  const cfg = readConfig(root);
  const state = {
    kind: project ? project.kind : null, status: 'starting', command: '', pid: null, startedAt: new Date().toISOString(), readyMs: null,
    port: null, configuredPort: Number(cfg['server.port']) || 8080, contextPath: cfg['server.servlet.context-path'] || '',
    ports: [], connections: [], datasource: cfg['spring.datasource.url'] || null, h2Console: null,
    endpoints: idx.endpoints.map((e) => ({ method: e.method, path: e.path, file: e.file, line: e.line, source: 'código' })), discovery: 'código',
    requests: [], findings: [], output: '', error: null, writes: false, probing: false,
  };
  const lines = [];
  let child = null, stopped = false, exited = false, lastEmit = 0, emitTimer = null;
  const findings = new Map();

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

  if (!project || !project.exe) {
    state.status = 'failed';
    state.error = !project ? t`No es un proyecto Spring Boot (no hay pom.xml ni build.gradle con spring-boot).` : t`No se encontró Maven: ni mvnw en el proyecto, ni mvn en el PATH, ni una distribución en ~/.m2/wrapper.`;
    setImmediate(() => emit(true));
    return { stop() {}, reprobe() {}, state: snapshot };
  }

  // ── Arranque. Primero sin conexión (Maven no consulta Internet: más rápido); si faltan dependencias, con conexión.
  // Si la aplicación no arranca por un error con arreglo seguro, se arranca una copia temporal con ese arreglo
  // («arranque en sombra») para poder probar la API igualmente. Tu código no se modifica.
  const attempt = { offline: project.kind === 'spring-maven', shadow: null };
  let runDir = root;
  const needKey = (n) => n.kind + ':' + n.key;
  const needs = new Map();
  function addNeed(n) {
    const prev = needs.get(needKey(n));
    if (prev && (prev.proven || !n.proven)) return;
    needs.set(needKey(n), n);
    state.needs = [...needs.values()];
    const WHAT = { driver: t`el driver de la base de datos (${n.what})`, db: t`una base de datos accesible`, env: t`el valor de «${n.what}»`, secret: t`la clave «${n.key}»`, service: t`el servicio en ${n.host || n.what}` };
    const WHY = {
      driver: t`La URL apunta a una base de datos real, pero el proyecto no incluye su driver (${n.what}).`,
      db: n.what ? t`La aplicación usa la base de datos ${n.what}${n.host ? t`, pero no responde en ${n.host}` : ''}.` : t`El proyecto usa el driver de una base de datos real, pero no dice a cuál conectarse.`,
      env: t`La configuración usa ${'${' + n.what + '}'} sin valor por defecto y esa variable no está definida.`,
      secret: t`La propiedad «${n.key}» está vacía o tiene un valor de ejemplo.`,
      service: t`«${n.key}» apunta a ${n.what}, pero ahí no responde nada.`,
    };
    const place = n.kind === 'db' && n.host ? t`Arranca la base de datos o corrige la URL en ${n.file}, línea ${n.line} (${n.key}).` : n.kind === 'driver' ? t`Añade la dependencia del driver en ${n.file}, dentro de <dependencies> (línea ${n.line}).` : n.add ? t`Añádelo al final de ${n.file} como ${n.key}=…` : t`Escríbelo en ${n.file}, línea ${n.line} (${n.key}).`;
    addFinding(F('context', 'live-needs-config', 'human', n.file, n.line, needKey(n), {
      confidence: n.proven ? 99 : 80, scope: undefined,
      title: t`Falta configuración: ${WHAT[n.kind]}`,
      why: WHY[n.kind] + ' ' + (n.proven ? t`Por eso la aplicación no arrancó.` : t`Puede que la aplicación no arranque.`) + ' ' + t`Mientras falte, Spectator solo puede hacer el análisis estático: no puede ejecutar la aplicación ni probar su API.`,
      action: place + (n.env && n.kind !== 'driver' ? ' ' + t`O define la variable de entorno ${n.env} (VS Code: terminal o launch.json; IntelliJ: Run Configuration → Environment variables).` : ''),
      tech: `${n.key}${n.what && n.what !== n.key ? ' = ' + n.what : ''}`, evidence: [n.proven ? t`Lo confirma el log de arranque` : t`Comprobado antes de arrancar`, ...(n.host ? [t`Sin respuesta en ${n.host}`] : [])],
      related: n.also ? [{ file: n.also.file, line: n.also.line }] : [],
    }));
  }

  /** Arreglos seguros para errores que impiden arrancar (hoy: atributos JPQL con un nombre parecido en la Entity). */
  function shadowFixes(text) {
    const fixes = [];
    const attr = /Could not resolve attribute '(\w+)'/.exec(text);
    if (!attr) return fixes;
    for (const q of idx.queries) for (const prob of checkJpql(idx, q)) {
      const near = closest(prob.attr, prob.fields);
      if (near) fixes.push({ file: q.file, line: q.line, from: prob.path, to: prob.path.replace(new RegExp('\\.' + prob.attr + '$'), '.' + near) });
    }
    return fixes;
  }
  function makeShadow(fixes) {
    const dir = path.join(os.tmpdir(), 'spectator-shadow', hash(root).slice(0, 12));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(root, dir, { recursive: true, filter: (src) => !/(^|[\\/])(\.git|node_modules|\.spectator|\.idea)([\\/]|$)/.test(path.relative(root, src)) });
    for (const f of fixes) {
      const abs = path.join(dir, f.file);
      fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace(f.from, f.to));
    }
    return dir;
  }

  async function launch() {
    exited = false;
    lines.length = 0;
    state.status = 'starting'; state.phase = null; state.port = null;
    let port = state.configuredPort;
    if (!(await portFree(port))) {
      port = await freePort();
      state.portNote = t`El puerto ${state.configuredPort} ya estaba ocupado; Spectator arrancó la aplicación en el ${port}.`;
    }
    const args = project.kind === 'spring-maven'
      ? [...(attempt.offline ? ['-o'] : []), ...project.args, `-Dspring-boot.run.arguments=--server.port=${port}`]
      : [...project.args, `--args=--server.port=${port}`];
    state.command = [project.exe, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
    const env = { ...process.env, SPRING_OUTPUT_ANSI_ENABLED: 'never' };
    if (!env.JAVA_HOME && process.platform === 'darwin') {
      try { env.JAVA_HOME = require('child_process').execFileSync('/usr/libexec/java_home', { encoding: 'utf8' }).trim(); } catch { /* java del PATH */ }
    }
    if (stopped) return;
    child = spawn(project.exe, args, { cwd: runDir, env, detached: process.platform !== 'win32' });
    state.pid = child.pid;
    let buf = '';
    const onData = (d) => {
      buf += String(d).replace(ANSI, '');
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const l of parts) onLine(l.replace(/\r$/, ''));
      emit();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { state.status = 'failed'; state.error = String(e.message || e); emit(true); });
    child.on('exit', (code, signal) => {
      exited = true;
      if (buf) onLine(buf);
      if (stopped) { state.status = 'stopped'; emit(true); return; }
      if (state.status === 'running') { state.status = 'exited'; state.exitCode = code; state.signal = signal; emit(true); return; }
      const text = lines.join('\n');
      if (attempt.offline && /offline mode|has not been downloaded from it before|Cannot access \S+ in offline mode|Could not resolve dependencies|Plugin .* could not be resolved/.test(text)) {
        attempt.offline = false;
        state.offlineNote = t`Faltaban dependencias en la caché de Maven: se descargan esta vez (las siguientes ejecuciones serán más rápidas).`;
        launch();
        return;
      }
      state.status = 'failed'; state.exitCode = code; state.phase = null;
      analyzeFailure();
      const found = failureNeeds(text, cfg, idx);
      for (const n of found) addNeed(n);
      // Si el log demuestra que falta configuración, la base de datos que no respondía también queda confirmada.
      if (found.some((n) => n.kind === 'db' || n.kind === 'driver')) for (const n of [...needs.values()]) if (n.kind === 'db' && !n.proven) addNeed({ ...n, proven: true });
      const fixes = attempt.shadow ? [] : shadowFixes(text);
      if (fixes.length) {
        try {
          runDir = makeShadow(fixes);
          attempt.shadow = { dir: runDir, fixes };
          state.shadow = attempt.shadow;
          const f = [...findings.values()].find((x) => x.rule === 'live-startup-failure');
          if (f) f.evidence.push(t`Spectator corrigió esto de forma provisional en una copia temporal (${fixes.map((x) => `${x.from} → ${x.to}`).join(', ')}) para seguir probando la API. Tu código no se modificó.`);
          launch();
          return;
        } catch (e) { state.shadowError = String(e.message || e); }
      }
      state.blockedNote = [...needs.values()].some((n) => n.proven) ? t`La API no se pudo probar: falta configuración (ver abajo). Mientras tanto solo funciona el análisis estático.` : t`La API no se pudo probar porque la aplicación no arrancó. Corrige el error de arranque y vuelve a intentarlo.`;
      emit(true);
    });
    emit(true);
  }
  (async () => {
    try { for (const n of await configNeeds(root, cfg, idx)) addNeed(n); } catch { /* la comprobación previa no debe impedir arrancar */ }
    launch();
  })();

  function onLine(l) {
    lines.push(l);
    if (lines.length > 20000) lines.splice(0, 5000);
    let m;
    if ((m = /(?:Tomcat|Netty|Jetty|Undertow) started on ports?\(?s?\)?:?\s*(\d+)/.exec(l))) { state.port = Number(m[1]); }
    if ((m = /Database available at '([^']+)'/.exec(l)) || (m = /url=(jdbc:[^\s,]+)/.exec(l))) state.datasource = m[1];
    if ((m = /H2 console available at '([^']+)'/.exec(l))) state.h2Console = m[1];
    if ((m = /HikariPool-\d+ - Added connection (\S+)/.exec(l))) state.pool = m[1];
    if (/Downloading from|Downloaded from/.test(l) && state.status === 'starting') state.phase = t`descargando dependencias`;
    else if (/maven-compiler-plugin|Compiling \d+ source/.test(l)) state.phase = t`compilando`;
    else if (/Starting \w+ using Java/.test(l)) state.phase = t`iniciando Spring`;
    if (/Started \w+ in [\d.]+ seconds/.test(l) && state.status !== 'running') {
      state.status = 'running';
      state.readyMs = Date.now() - Date.parse(state.startedAt);
      state.phase = null;
      setTimeout(() => { inspectSockets(); probe(); }, 300);
    }
  }

  // ── Puertos y conexiones del grupo de procesos (mvn + la JVM que arranca)
  function inspectSockets() {
    if (process.platform === 'win32' || !child) return Promise.resolve();
    return new Promise((resolve) => {
      execFile('lsof', ['-nP', '-a', '-g', String(child.pid), '-iTCP'], { timeout: 5000 }, (err, out) => {
        const listen = new Set(), conns = new Set(), own = new Set();
        for (const line of String(out || '').split('\n').slice(1)) {
          const m = /TCP (\S+?)(?:->(\S+))? \((\w+)\)/.exec(line);
          if (!m) continue;
          own.add(m[1]);
          if (m[3] === 'LISTEN') listen.add(m[1]);
          else if (m[3] === 'ESTABLISHED' && m[2]) conns.add(m[2]);
        }
        state.ports = [...listen];
        // Las conexiones entre Maven y la JVM que arrancó son internas: solo se muestran las que salen del grupo.
        state.connections = [...conns].filter((c) => !own.has(c) && !c.endsWith(':' + state.port));
        emit();
        resolve();
      });
    });
  }

  // ── Fallo de arranque: errores de compilación o el último «Caused by:»
  function analyzeFailure() {
    const text = lines.join('\n');
    const compile = [...text.matchAll(/\[ERROR\]\s+(\/[^\n]+?\.java):\[(\d+),(\d+)\]\s+([^\n]+)/g)];
    if (compile.length) {
      for (const [, abs, line, , msg] of compile.slice(0, 20)) {
        const rel = path.relative(runDir, abs).split(path.sep).join('/');
        addFinding(F('correctness', 'live-compile-error', 'fail', rel, Number(line), msg, {
          title: t`No compila: ${msg}`, why: t`Maven no pudo compilar este archivo, así que la aplicación no llega a arrancar.`,
          action: t`Corregir el error en la línea indicada.`, tech: `${rel}:${line} ${msg}`, evidence: [t`Salida de Maven (maven-compiler-plugin)`],
        }));
      }
      state.error = t`El proyecto no compila.`;
      return;
    }
    const causes = lines.map((l, i) => [l, i]).filter(([l]) => /^Caused by: /.test(l.trim()));
    const lastIdx = causes.length ? causes[causes.length - 1][1] : lines.findIndex((l) => /APPLICATION FAILED TO START|Exception/.test(l));
    const cause = causes.length ? causes[causes.length - 1][0].trim().replace(/^Caused by: /, '') : (lines.find((l) => /Description:/.test(l)) ? lines.slice(lines.findIndex((l) => /Description:/.test(l)) + 1).find((l) => l.trim()) || '' : (lines.filter((l) => /ERROR/.test(l)).pop() || t`la aplicación terminó sin arrancar`)).trim();
    state.error = cause;
    let file = null, line = 1;
    const related = [];
    // Atributo JPQL inexistente: se busca la @Query que lo usa.
    const attr = /Could not resolve attribute '(\w+)'(?: of '([\w.$]+)')?/.exec(text);
    const forMethod = /for method [^\n]*?\.(\w+)\.(\w+)\(/.exec(text);
    if (attr) {
      const q = idx.queries.find((x) => new RegExp('\\.' + attr[1] + '\\b').test(x.text) && (!forMethod || x.method === forMethod[2])) || idx.queries.find((x) => x.text.includes(attr[1]));
      if (q) { file = q.file; line = q.line; }
      const entName = attr[2] && attr[2].split('.').pop();
      const ent = entName && idx.entities.get(entName);
      if (ent) related.push({ file: ent.rel, line: ent.line });
    } else if (forMethod) {
      const q = idx.queries.find((x) => x.method === forMethod[2]);
      if (q) { file = q.file; line = q.line; }
    }
    if (!file) { const fr = projectFrame(lines.slice(Math.max(0, lastIdx))); if (fr) ({ file, line } = fr); }
    if (/Port \d+ was already in use/.test(text)) { file = fileIfExists('src/main/resources/application.properties') || file; line = 1; }
    const plain = explain(cause) || explain(text) || t`La aplicación se detuvo durante el arranque.`;
    addFinding(F('correctness', 'live-startup-failure', 'fail', file || 'pom.xml', line, cause.slice(0, 120), {
      confidence: 99, title: t`La aplicación compila pero no arranca`,
      why: plain + ' ' + t`El compilador de Java no revisa esto: solo aparece al ejecutar.`,
      action: attr ? t`Corregir el atributo «${attr[1]}» en la consulta (comparar con los campos de la Entity) y volver a arrancar.` : t`Leer la causa (último «Caused by») y corregir el archivo indicado.`,
      tech: cause, evidence: [t`Último «Caused by:» del log de arranque`, ...causes.slice(-3).map(([l]) => l.trim().slice(0, 300))], related,
    }));
  }
  function fileIfExists(rel) { return fs.existsSync(path.join(root, rel)) ? rel : null; }
  /** Primera línea «at paquete.Clase.metodo(Archivo.java:N)» que pertenece al proyecto. */
  function projectFrame(chunk) {
    for (const l of chunk) {
      const m = /at ([\w.$]+)\.([\w$<>]+)\((\w+\.java):(\d+)\)/.exec(l);
      if (!m) continue;
      const cls = m[1].split('$')[0];
      const rel = 'src/main/java/' + cls.split('.').slice(0, -1).join('/') + '/' + m[3];
      if (fs.existsSync(path.join(root, rel))) return { file: rel, line: Number(m[4]), frame: l.trim() };
    }
    return null;
  }

  // ── Sondeo de la API
  const base = () => `http://127.0.0.1:${state.port}${state.contextPath}`;
  async function request(method, urlPath, body, why) {
    const from = lines.length;
    const started = Date.now();
    const entry = { method, url: urlPath, status: null, ms: null, why, at: new Date().toISOString() };
    state.requests.push(entry);
    emit();
    let res, text = '';
    try {
      res = await fetch(base() + urlPath, { method, headers: body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
      text = await res.text();
      entry.status = res.status;
    } catch (e) { entry.error = String(e.message || e); }
    entry.ms = Date.now() - started;
    // El log de la petición puede llegar un poco después que la respuesta.
    await new Promise((r) => setTimeout(r, entry.status >= 500 ? 400 : 60));
    const log = lines.slice(from);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* no es JSON */ }
    const exc = log.find((l) => /Exception|Error:/.test(l) && !/DEBUG/.test(l));
    // Solo la excepción, sin la fecha ni el hilo del log.
    if (exc) entry.log = exc.trim().replace(/^.*?(?=[\w.]+(?:Exception|Error)\b)/, '').slice(0, 240);
    emit();
    return { status: entry.status, json, text, log, entry };
  }

  const sample = (type, name) => {
    const n = name.toLowerCase();
    if (/^(long|Long|int|Integer|short|Short)$/.test(type)) return /id$/.test(n) ? 1 : 10;
    if (/^(double|Double|float|Float|BigDecimal)$/.test(type)) return 100;
    if (/^(boolean|Boolean)$/.test(type)) return true;
    if (/LocalDateTime|Instant|OffsetDateTime|ZonedDateTime|Date/.test(type)) return '2030-06-15T10:00:00';
    if (/LocalDate/.test(type)) return '2030-06-15';
    return 'a';
  };
  /** Cuerpo válido para un DTO a partir de sus anotaciones (min/max, @Future…). */
  function validBody(dto, ids, tag) {
    const body = {};
    for (const f of dto.fields) {
      const type = f.type, a = f.annos || '';
      const min = Number((/@Size\([^)]*min\s*=\s*(\d+)/.exec(a) || [])[1] || 0), max = Number((/@Size\([^)]*max\s*=\s*(\d+)/.exec(a) || [])[1] || 40);
      if (/^(String|CharSequence)$/.test(type)) {
        let v = `Spectator ${tag}`;
        if (v.length > max) v = ('SPX' + tag).slice(0, max);
        while (v.length < min) v += 'x';
        body[f.name] = /@Email/.test(a) ? 'spectator@example.com' : v;
      } else if (/(^|\.)(long|Long|int|Integer)$/.test(type)) {
        const minV = Number((/@Min\(\s*(?:value\s*=\s*)?(\d+)/.exec(a) || [])[1] || (/@Positive\b/.test(a) ? 1 : 0));
        body[f.name] = /Id$/.test(f.name) ? (ids.get(f.name.replace(/Id$/, '').toLowerCase()) || 1) : Math.max(minV, 5);
      } else body[f.name] = sample(type, f.name);
    }
    return body;
  }
  /** Busca recursivamente un objeto con ese id en una respuesta JSON. */
  const findById = (json, id) => {
    if (!json || typeof json !== 'object') return null;
    if (!Array.isArray(json) && json.id === id) return json;
    for (const v of Object.values(json)) { const r = findById(v, id); if (r) return r; }
    return null;
  };
  const firstIds = (json) => {
    const out = [];
    const walk = (j) => { if (!j || typeof j !== 'object') return; if (!Array.isArray(j) && typeof j.id === 'number') out.push(j.id); for (const v of Object.values(j)) if (typeof v === 'object') walk(v); };
    walk(json);
    return out;
  };

  function locate(ep, res) {
    // Preferimos la línea del proyecto que aparece en la pila del log; si no, el método del service; si no, el handler.
    const fr = res && projectFrame(res.log);
    const del = delegate(idx, ep);
    if (fr) return { file: fr.file, line: fr.line, frame: fr.frame, del };
    if (del) return { file: del.file, line: del.line, del };
    return { file: ep.file, line: ep.line, del };
  }
  const handlerRef = (ep) => ({ file: ep.file, line: ep.line });
  const logCause = (res) => { const l = res.log.filter((x) => /Exception|Error/.test(x)); return (l.find((x) => /^Caused by|LazyInit|NoSuchElement|NotWritable/.test(x.trim())) || l[0] || '').trim().slice(0, 300); };

  async function probe() {
    if (state.probing || state.status !== 'running') return;
    state.probing = true;
    state.requests = [];
    const ds = state.datasource || '';
    state.writes = !!opts.allowWrites || /jdbc:(h2:mem|hsqldb:mem|derby:memory)/.test(ds);
    emit(true);
    try {
      // Descubrimiento: springdoc si está, el código siempre (para archivo y línea).
      const docs = await request('GET', cfg['springdoc.api-docs.path'] || '/v3/api-docs', undefined, t`descubrir endpoints (springdoc)`);
      if (docs.status === 200 && docs.json && docs.json.paths) {
        state.discovery = 'springdoc + código';
        const seen = new Set(state.endpoints.map((e) => e.method + ' ' + e.path));
        for (const [p, ops] of Object.entries(docs.json.paths)) for (const m of Object.keys(ops)) {
          const key = m.toUpperCase() + ' ' + p;
          if (seen.has(key)) state.endpoints.find((e) => e.method + ' ' + e.path === key).source = 'springdoc + código';
          else state.endpoints.push({ method: m.toUpperCase(), path: p, source: 'springdoc' });
        }
      }
      const eps = idx.endpoints;
      const ids = new Map(); // recurso (p. ej. «categoria») → id existente
      const resource = (p) => (p.split('/').filter((s) => s && !s.startsWith('{')).pop() || '').toLowerCase();
      const stem = (r) => r.replace(/(ies|ie|i|e|s)$/, '');
      const idFor = (p) => { const r = stem(resource(p)); for (const [k, v] of ids) if (stem(k) === r || k.startsWith(r) || r.startsWith(stem(k))) return v; return 1; };
      const queryFor = (ep) => {
        const q = ep.params.filter((p) => /@RequestParam\b/.test(p.annos) && !/required\s*=\s*false|defaultValue/.test(p.annos));
        return q.length ? '?' + q.map((p) => `${encodeURIComponent((/["']([^"']+)["']/.exec(p.annos) || [])[1] || p.name)}=${encodeURIComponent(sample(p.type, p.name))}`).join('&') : '';
      };
      const lists = [];

      // 1) GET sin variables en la ruta: deben responder 2xx. De paso se aprenden ids existentes.
      for (const ep of eps.filter((e) => e.method === 'GET' && !e.path.includes('{'))) {
        const res = await request('GET', ep.path + queryFor(ep), undefined, t`GET normal`);
        if (res.status >= 200 && res.status < 300) {
          const found = firstIds(res.json);
          if (found.length && !ids.has(resource(ep.path))) ids.set(resource(ep.path), found[0]);
          lists.push(ep);
          const page = res.json && (res.json.size ?? (res.json.page && res.json.page.size));
          if (typeof page === 'number') res.entry.note = t`tamaño de página por defecto: ${page}`;
        } else if (res.status >= 500) serverError(ep, res);
      }
      // 2) GET /{id}: con un id que existe debe dar 2xx; con uno que no existe, 404.
      for (const ep of eps.filter((e) => e.method === 'GET' && /\{[^}]+\}$/.test(e.path))) {
        const okPath = ep.path.replace(/\{[^}]+\}$/, String(idFor(ep.path))).replace(/\{[^}]+\}/g, '1');
        const ok = await request('GET', okPath, undefined, t`GET de un id que existe`);
        if (ok.status >= 500) serverError(ep, ok);
        const miss = await request('GET', ep.path.replace(/\{[^}]+\}$/, String(MISSING_ID)).replace(/\{[^}]+\}/g, '1'), undefined, t`GET de un id que no existe`);
        if (miss.status >= 500) notFound500(ep, miss, 'GET');
      }
      // 3) DELETE de un id que no existe: debe dar 404, no 204/200.
      for (const ep of eps.filter((e) => e.method === 'DELETE' && /\{[^}]+\}$/.test(e.path))) {
        const p = ep.path.replace(/\{[^}]+\}$/, String(MISSING_ID)).replace(/\{[^}]+\}/g, '1');
        const check = eps.find((e) => e.method === 'GET' && e.path === ep.path) ? await request('GET', p, undefined, t`comprobar que el id no existe`) : null;
        if (check && check.status >= 200 && check.status < 300) continue;
        const res = await request('DELETE', p, undefined, t`DELETE de un id que no existe`);
        if (res.status >= 200 && res.status < 300) {
          const loc = locate(ep, null);
          addFinding(F('correctness', 'live-delete-not-404', 'fail', loc.file, loc.line, ep.handler, {
            title: t`DELETE ${ep.path} responde ${res.status} aunque el registro no existe`,
            why: t`Spectator borró el id ${MISSING_ID}, que no existe, y la API contestó «${res.status} borrado con éxito». El cliente cree que borró algo. deleteById ignora en silencio los ids inexistentes.`,
            action: t`Comprobar antes con existsById(id) y lanzar ResourceNotFoundException (404) si no existe.`,
            tech: t`DELETE ${p} → ${res.status} en ${res.entry.ms} ms`, evidence: [t`Petición real a ${base()}${p}`, t`Handler: ${ep.handler} (${ep.file}:${ep.line})`], related: [handlerRef(ep)],
          }));
        } else if (res.status >= 500) notFound500(ep, res, 'DELETE');
      }
      if (!state.writes) {
        state.writesNote = t`No se enviaron POST ni PUT: la base de datos no es en memoria (${ds || t`desconocida`}). Actívalo con spectator.live.allowWrites si es una base de pruebas.`;
        emit();
      } else {
        // 4) POST: un cuerpo con campos en blanco debe rechazarse (400); uno válido, crearse.
        for (const ep of eps.filter((e) => e.method === 'POST' && !e.path.includes('{'))) {
          const bodyParam = ep.params.find((p) => /@RequestBody\b/.test(p.annos));
          const dto = bodyParam && idx.classes.get(simpleTypes(bodyParam.type)[0]);
          if (!dto) continue;
          const blank = Object.fromEntries(dto.fields.map((f) => [f.name, /^(String|CharSequence)$/.test(f.type) ? '' : null]));
          const res = await request('POST', ep.path, blank, t`POST con campos en blanco`);
          if (res.status >= 200 && res.status < 300) {
            const valid = /@Valid\b|@Validated\b/.test(bodyParam.annos);
            addFinding(F('correctness', 'live-no-validation', 'fail', ep.file, ep.line, ep.handler, {
              title: t`POST ${ep.path} acepta datos en blanco (respondió ${res.status})`,
              why: (hasConstraints(dto) && !valid ? t`${dto.name} tiene reglas como @NotBlank, pero el controller no tiene @Valid, así que nadie las comprueba.` : t`No hay reglas de validación que rechacen estos datos.`) + ' ' + t`Spectator envió ${JSON.stringify(blank)} y se guardó igualmente.`,
              action: hasConstraints(dto) && !valid ? t`Añadir @Valid delante de @RequestBody en ${ep.handler}.` : t`Añadir anotaciones de validación al DTO y @Valid en el controller.`,
              tech: t`POST ${ep.path} → ${res.status} con cuerpo en blanco`, evidence: [t`Petición real a ${base()}${ep.path}`, t`Respuesta: ${res.text.slice(0, 200)}`], related: [{ file: dto.rel, line: dto.line }],
            }));
            const created = res.json && res.json.id;
            if (typeof created === 'number' && !ids.has(resource(ep.path))) ids.set(resource(ep.path), created);
          } else if (res.status >= 500) serverError(ep, res);
        }
        // 5) PUT /{id} con datos válidos y relectura: el cambio tiene que quedar guardado.
        for (const ep of eps.filter((e) => e.method === 'PUT' && /\{[^}]+\}$/.test(e.path))) {
          const bodyParam = ep.params.find((p) => /@RequestBody\b/.test(p.annos));
          const dto = bodyParam && idx.classes.get(simpleTypes(bodyParam.type)[0]);
          if (!dto) continue;
          const id = idFor(ep.path);
          const tag = String(Date.now() % 100000);
          const body = validBody(dto, ids, tag);
          const p = ep.path.replace(/\{[^}]+\}$/, String(id)).replace(/\{[^}]+\}/g, '1');
          const res = await request('PUT', p, body, t`PUT con datos válidos`);
          if (res.status >= 500) { serverError(ep, res); continue; }
          if (!(res.status >= 200 && res.status < 300)) { res.entry.note = t`el sondeo no consiguió datos válidos (${res.status})`; continue; }
          // Releer: primero GET /{id}; si falla, cualquier listado que contenga ese id.
          let after = null, via = '';
          const getOne = eps.find((e) => e.method === 'GET' && e.path === ep.path);
          if (getOne) { const g = await request('GET', p, undefined, t`releer tras el PUT`); if (g.status === 200) { after = g.json; via = 'GET ' + p; } }
          if (!after) {
            for (const l of lists.filter((x) => resource(x.path) === resource(ep.path) || x.path.startsWith(ep.path.replace(/\/\{[^}]+\}$/, '')))) {
              const g = await request('GET', l.path + (queryFor(l) || '?size=1000'), undefined, t`releer tras el PUT`);
              const obj = findById(g.json, id);
              if (obj) { after = obj; via = 'GET ' + l.path; break; }
            }
          }
          if (!after) { res.entry.note = t`no se pudo releer el registro para comprobar el cambio`; continue; }
          const lost = Object.entries(body).filter(([k, v]) => typeof v === 'string' && k in after && after[k] !== v);
          if (lost.length) {
            const loc = locate(ep, null);
            const tx = loc.del && !/@Transactional\b/.test(loc.del.method.annos) && !/@Transactional\b/.test(loc.del.cls.annos);
            addFinding(F('correctness', 'live-update-lost', 'fail', loc.file, loc.line, ep.handler, {
              title: t`PUT ${ep.path} responde ${res.status} pero el cambio no se guarda`,
              why: t`Spectator cambió ${lost.map(([k, v]) => `${k} = «${v}»`).join(', ')} y la API dijo que todo fue bien; al volver a leer el registro (${via}) sigue con ${lost.map(([k]) => `${k} = «${after[k]}»`).join(', ')}. ` + (tx ? t`El método del service no tiene @Transactional: la entidad queda «detached» y Hibernate no guarda los cambios (no hay dirty checking ni save()).` : t`Probablemente falta save() o una transacción.`),
              action: tx ? t`Añadir @Transactional a ${loc.del.cls.name}.${loc.del.method.name} (o llamar a save(entity)).` : t`Guardar la entidad con save() dentro de una transacción.`,
              tech: t`PUT ${p} → ${res.status}; relectura con ${via}`, evidence: [t`Cuerpo enviado: ${JSON.stringify(body)}`, t`Valor leído después: ${JSON.stringify(Object.fromEntries(lost.map(([k]) => [k, after[k]])))}`], related: [handlerRef(ep)],
            }));
          } else res.entry.note = t`el cambio quedó guardado`;
        }
      }
    } finally {
      state.probing = false;
      state.probedAt = new Date().toISOString();
      await inspectSockets();
      emit(true);
    }
  }

  function serverError(ep, res) {
    const cause = logCause(res);
    const loc = locate(ep, res);
    const lazy = /LazyInitialization|could not initialize proxy|NotWritable|JsonMapping|Infinite recursion/.test(res.log.join('\n'));
    const returnsEntity = simpleTypes(ep.member.type).find((n) => idx.entities.has(n));
    const file = lazy && returnsEntity ? ep.file : loc.file, line = lazy && returnsEntity ? ep.line : loc.line;
    addFinding(F('correctness', 'live-server-error', 'fail', file, line, ep.handler, {
      title: t`${ep.method} ${ep.path} falla con ${res.status} en una petición normal`,
      why: (explain(res.log.join('\n')) || t`El servidor lanzó una excepción que nadie manejó.`) + (lazy && returnsEntity ? ' ' + t`El endpoint devuelve la Entity ${returnsEntity}: devuelve un DTO creado dentro del Service.` : ''),
      action: lazy && returnsEntity ? t`Cambiar el tipo de retorno a un DTO (por ejemplo ${returnsEntity.replace(/Entity$/, '')}ResponseDTO) y convertir dentro del Service.` : t`Leer la excepción del log y corregir el archivo indicado.`,
      tech: cause || t`HTTP ${res.status} sin excepción en el log`, evidence: [t`Petición real: ${res.entry.method} ${res.entry.url} → ${res.status} (${res.entry.ms} ms)`, ...(loc.frame ? [loc.frame] : []), ...(cause ? [cause] : [])], related: [handlerRef(ep)],
    }));
  }
  function notFound500(ep, res, method) {
    const cause = logCause(res);
    const loc = locate(ep, res);
    addFinding(F('correctness', 'live-500-not-404', 'fail', loc.file, loc.line, method + ' ' + ep.handler, {
      title: t`${method} ${ep.path} con un id que no existe responde ${res.status} en vez de 404`,
      why: (explain(res.log.join('\n')) || t`Se lanzó una excepción que nadie convirtió en una respuesta clara.`) + ' ' + t`El cliente recibe «error interno del servidor» cuando lo correcto es «no encontrado».`,
      action: /NoSuchElement/.test(res.log.join('\n')) ? t`Cambiar .get() por .orElseThrow(() -> new ResourceNotFoundException(...)).` : t`Lanzar ResourceNotFoundException (manejada como 404) cuando el registro no existe.`,
      tech: cause || `HTTP ${res.status}`, evidence: [t`Petición real: ${method} ${res.entry.url} → ${res.status} (${res.entry.ms} ms)`, ...(loc.frame ? [loc.frame] : [])], related: [handlerRef(ep)],
    }));
  }

  return {
    state: snapshot,
    reprobe: () => { for (const [k, f] of findings) if (f.rule !== 'live-startup-failure' && f.rule !== 'live-compile-error') findings.delete(k); opts.onFinding && opts.onFinding([...findings.values()]); return probe(); },
    stop() {
      if (stopped) return;
      stopped = true;
      if (!child || exited) { state.status = 'stopped'; emit(true); return; }
      try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']); else process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch { /* ya terminó */ } }
      if (process.platform !== 'win32') setTimeout(() => { if (!exited) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ya terminó */ } } }, 5000).unref();
    },
  };
}

module.exports = { startSpringLive, detectProject, findMaven, readConfig, configNeeds, failureNeeds };
