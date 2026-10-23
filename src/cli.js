#!/usr/bin/env node
'use strict';
// Las gramáticas grandes (Swift) hacen fallar al compilador optimizador de WebAssembly en algunas versiones de Node;
// el flag solo se acepta al arrancar, así que el comando se relanza una vez con él.
if (!process.execArgv.includes('--liftoff-only')) {
  const r = require('child_process').spawnSync(process.execPath, ['--liftoff-only', ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('./core');
const { writeJson, stateDir } = require('./core/util');
const { buildReport } = require('./report');

const { t, setLocale } = require('./core/i18n');

const C = process.stdout.isTTY ? { red: '\x1b[31m', yel: '\x1b[33m', grn: '\x1b[32m', mag: '\x1b[35m', dim: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' } : { red: '', yel: '', grn: '', mag: '', dim: '', b: '', x: '' };
const verdict = (v) => ({ pass: `${C.grn}${t`Sin problemas detectados`}${C.x}`, risk: `${C.yel}${t`Con riesgos`}${C.x}`, fail: `${C.red}${t`Con fallas`}${C.x}`, human: `${C.mag}${t`Necesita tu decisión`}${C.x}` })[v];
const sev = (v) => ({ fail: `${C.red}${t`FALLA`}${C.x}`, risk: `${C.yel}${t`RIESGO`}${C.x}`, human: `${C.mag}${t`DECIDE`}${C.x}` })[v];

const help = () => t`Spectator — evidencia determinista sobre tu código (sin IA)

Uso:
  spectator scan [carpeta] [--deep] [--json] [--html [archivo]] [--new] [--baseline] [--lang es|en|ja]
  spectator trace [carpeta] -- <comando node>     flujo real de ejecución (Node.js)
  spectator api [carpeta] [--target URL] [--port N] [--log archivo]   vigila las llamadas a tu API y explica sus errores
  spectator backend [carpeta] [--json]          mapa del backend: endpoints, DTO y qué llama a qué
  spectator cronologia [carpeta] [--json]       archivos cambiados hoy y qué IA los cambió

Opciones:
  --deep       además ejecuta npm audit, gitleaks y osv-scanner si están instalados
  --json       escribe el resultado completo por la salida estándar
  --html       genera un informe navegable (por defecto .spectator/report.html)
  --new        muestra solo lo nuevo desde el punto de partida
  --baseline   marca el estado actual como punto de partida
  --lang       idioma de los textos: es, en o ja (por defecto, el del sistema)
  --target     URL de tu servidor (por defecto, la que se deduce del proyecto)
  --port       puerto local del vigía; llama a la API a través de él (por defecto 8099)
  --log        archivo de log de tu aplicación para leer sus errores (se puede repetir)
Código de salida de scan: 1 si hay fallas demostradas (útil en CI), 0 en otro caso.
Código de salida de trace: el del programa ejecutado; 2 si no pudo iniciarse o no se pudo observar; 130 si lo cancelas.`;

const r0Locale = () => Intl.DateTimeFormat().resolvedOptions().locale;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  // Las opciones de Spectator terminan en «--»: lo que va detrás pertenece al programa que se ejecuta.
  const end = argv.indexOf('--');
  const langAt = argv.indexOf('--lang');
  const lang = langAt !== -1 && (end === -1 || langAt < end) ? argv.splice(langAt, 2)[1] : process.env.SPECTATOR_LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  setLocale(lang);
  if (!cmd || cmd === '-h' || cmd === '--help') return console.log(help());
  const dash = argv.indexOf('--');
  const own = dash === -1 ? argv.slice(1) : argv.slice(1, dash);
  // Opciones con valor: se sacan antes de buscar la carpeta.
  const takeAll = (name) => { const vals = []; for (let i; (i = own.indexOf(name)) !== -1;) vals.push(own.splice(i, 2)[1]); return vals; };
  const targetArg = takeAll('--target').pop(), portArg = takeAll('--port').pop(), logArgs = takeAll('--log');
  const flags = new Set(own.filter((a) => a.startsWith('--')));
  const pos = own.filter((a) => !a.startsWith('--'));
  const htmlIdx = own.indexOf('--html');
  const htmlArg = htmlIdx !== -1 && own[htmlIdx + 1] && !own[htmlIdx + 1].startsWith('--') ? own[htmlIdx + 1] : null;
  const root = path.resolve(pos.find((p) => p !== htmlArg) || '.');
  if (!fs.existsSync(root)) { console.error(t`No existe la carpeta: ${root}`); process.exit(2); }
  const engine = new Engine(root);

  if (cmd === 'scan') {
    const r = await engine.scan({ deep: flags.has('--deep'), resetBaseline: flags.has('--baseline') });
    const dir = stateDir(root);
    writeJson(path.join(dir, 'findings.json'), r.findings);
    writeJson(path.join(dir, 'statements.json'), r.statements);
    writeJson(path.join(dir, 'project-model.json'), { ...r, findings: undefined, statements: undefined });
    if (flags.has('--html')) {
      const out = path.resolve(htmlArg || path.join(dir, 'report.html'));
      fs.writeFileSync(out, buildReport(r));
      console.error(t`Informe: ${out}`);
    }
    if (flags.has('--json')) { process.stdout.write(JSON.stringify(r)); process.exit(r.counts.fail ? 1 : 0); }
    print(r, flags.has('--new'));
    process.exit(r.counts.fail ? 1 : 0);
  } else if (cmd === 'trace') {
    if (dash === -1 || !argv[dash + 1]) { console.error(t`Falta el comando. Ejemplo: spectator trace -- node src/server.js`); process.exit(2); }
    await engine.scan();
    // Se pasa como lista para conservar argumentos con espacios o comillas.
    const command = argv.slice(dash + 1);
    console.log(C.dim + t`Ejecutando: ${command.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}` + C.x);
    let cancelled = false;
    const tracer = engine.trace(command, {
      onOutput: (text) => process.stdout.write(C.dim + text + C.x),
      onUpdate: ({ delta }) => { for (const [id, n] of Object.entries(delta)) console.log(`  ${C.grn}⚡${C.x} ${id.replace('#', ' → ')} ${C.dim}×${n}${C.x}`); },
      onExit: (d) => {
        const n = Object.keys(d.counts).length;
        const total = engine.last.graph.units.length;
        console.log(`\n${C.b}${t`${n} de ${total} funciones se ejecutaron`}${C.x} ${C.dim}${t`(${(d.durationMs / 1000).toFixed(1)} s, código de salida ${d.exitCode})`}${C.x}`);
        if (d.error) console.error(C.red + t`No se pudo iniciar el comando: ${d.error}` + C.x);
        // El programa pudo terminar bien sin que se observara nada: eso es un fallo del trazador, no «cero funciones».
        else if (d.instrumentation === 'unavailable' && !cancelled) console.error(C.yel + t`El programa se ejecutó, pero no se pudo observar: no se sabe qué funciones usó.` + C.x);
        // El resultado del programa es el resultado de trace: un fallo no se convierte en éxito.
        process.exit(d.error ? 2 : cancelled ? 130 : d.instrumentation === 'unavailable' ? 2 : d.signal ? 128 + (os.constants.signals[d.signal] || 0) : d.exitCode ?? 1);
      },
    });
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cancelled = true; tracer.stop(); });
  } else if (cmd === 'backend') {
    // El mapa del backend en la terminal: cada endpoint en una frase y su recorrido.
    const r = await engine.scan({ git: false });
    const B = r.backend;
    if (flags.has('--json')) { process.stdout.write(JSON.stringify(B)); process.exit(0); }
    if (!B) { console.log(t`No reconozco un backend en esta carpeta`); process.exit(0); }
    for (const e of B.endpoints) {
      console.log(`\n${C.b}${e.method} ${e.path}${C.x} ${C.dim}${e.file}:${e.line}${C.x}`);
      console.log('  ' + e.summary);
      for (const st of e.steps) console.log(`  ${'  '.repeat(st.depth)}${C.dim}${st.roleName}${C.x} ${st.kind === 'external' ? `${st.method} ${st.url}` : `${st.cls}.${st.method}`}${st.verb ? C.dim + ' — ' + st.verb + C.x : ''}`);
      for (const x of e.errors) if (x.exception) console.log(`  ${x.status >= 500 ? C.red : C.yel}${x.exception} → ${x.status}${C.x}`);
      if (e.example) console.log(`  ${C.dim}${t`Pruébalo:`} ${e.example.curl}${C.x}`);
    }
    process.exit(0);
  } else if (cmd === 'cronologia' || cmd === 'timeline') {
    // Lo que cambió hoy y qué IA lo cambió, según sus registros locales y los commits.
    const { aiEdits, chronology } = require('./core/provenance');
    const c = chronology({ ai: aiEdits(root) });
    if (flags.has('--json')) { process.stdout.write(JSON.stringify(c)); process.exit(0); }
    if (!c.entries.length) console.log(t`Hoy no ha cambiado ningún archivo de este proyecto`);
    for (const e of c.entries) console.log(`${new Date(e.at).toLocaleTimeString(r0Locale())} ${C.b}${e.who || t`Sin IA detectada`}${C.x} ${e.file}${e.added || e.removed ? ` ${C.dim}+${e.added || 0} −${e.removed || 0}${C.x}` : ''}${e.commit ? ` ${C.dim}(commit ${e.commit})${C.x}` : ''}`);
    process.exit(0);
  } else if (cmd === 'api') {
    await apiCommand(root, engine, { target: targetArg, port: portArg, logs: logArgs });
  } else if (cmd === 'live') {
    // spectator live [carpeta] [--json] [--keep]: arranca la app (Spring Boot o Node/Express), sondea su API y para al terminar.
    const { startLive } = require('./core/live');
    let last = null;
    const live = startLive({ root, allowWrites: flags.has('--allow-writes'), onState: (s) => {
      if (!flags.has('--json') && (!last || last.status !== s.status || last.phase !== s.phase)) console.error(`[spectator] ${s.status}${s.phase ? ' · ' + s.phase : ''}${s.port ? ' · :' + s.port : ''}`);
      last = s;
    } });
    process.on('SIGINT', () => { live.stop(); });
    await new Promise((resolve) => { const tick = setInterval(() => { const s = live.state(); if ((['failed', 'exited', 'stopped'].includes(s.status) && !s.probing) || (s.status === 'running' && s.probedAt)) { clearInterval(tick); resolve(); } }, 500); });
    const s = live.state();
    if (flags.has('--json')) console.log(JSON.stringify({ ...s, output: s.output.split('\n').slice(-60).join('\n') }, null, 2));
    else {
      console.log(`${s.status} · ${s.command}`);
      if (s.shadow) console.log(`shadow ${s.shadow.dir}: ${s.shadow.fixes.map((x) => x.from + ' → ' + x.to).join(', ')}`);
      if (s.blockedNote) console.log(s.blockedNote);
      if (s.port) console.log(`port ${s.port} · ${s.datasource || ''} · listen ${s.ports.join(', ')}`);
      for (const r of s.requests) console.log(`  ${r.method.padEnd(6)} ${r.url} → ${r.status ?? r.error} ${r.ms} ms${r.note ? ' · ' + r.note : ''}`);
      for (const f of s.findings) console.log(`${sev(f.severity)} ${f.file}:${f.line}  ${f.title}\n    ${f.why}\n    → ${f.action}`);
    }
    if (!flags.has('--keep')) live.stop();
    await new Promise((r) => setTimeout(r, 1500));
    process.exit(s.findings.some((f) => f.severity === 'fail') ? 1 : 0);
  } else { console.log(help()); process.exit(2); }
}

/** Vigila la API (y los logs) e imprime cada llamada; los errores con su explicación y el archivo implicado. */
async function apiCommand(root, engine, o) {
  const { startApiWatch, guessTarget } = require('./core/apiwatch');
  const { watchLogs } = require('./core/logwatch');
  await engine.scan({ git: false });
  const files = () => engine.last.graph.files.map((f) => f.rel);
  const guess = guessTarget(root);
  const target = o.target || guess.url;
  const where = (frames) => (frames && frames[0] ? ` ${C.b}${frames[0].file}:${frames[0].line}${C.x}` : '');
  const show = (e) => {
    if (e.type === 'log') {
      console.log(`${C.red}${t`ERROR EN EL LOG`}${C.x} ${e.headline}${where(e.frames)}`);
      if (e.cause) console.log(`        ${C.dim}${t`Causa: ${e.cause}`}${C.x}`);
      return;
    }
    if (e.asset && e.status < 400) return;
    const x = e.explanation, col = x.level === 'server' || x.level === 'network' ? C.red : x.level === 'client' ? C.yel : C.dim;
    console.log(`${col}${e.status || x.label}${C.x} ${e.method} ${e.path} ${C.dim}${e.ms} ms${C.x} · ${x.title}${where(e.frames)}`);
    if (x.level === 'server' || x.level === 'client' || x.level === 'network') {
      if (e.message) console.log(`        ${t`El servidor dice: ${e.message}`}`);
      console.log(`        ${C.dim}${x.meaning} ${x.check}${C.x}`);
    }
  };
  let watch;
  try { watch = await startApiWatch({ target, port: o.port ? Number(o.port) : 8099, root, files, onEvent: show }); } catch (e) {
    console.error(t`No se pudo arrancar el vigía de API: ${e.message}`); process.exit(2);
  }
  const logs = o.logs.length ? watchLogs({ files: o.logs.map((f) => path.resolve(root, f)), root, projectFiles: files, onEvent: show }) : null;
  console.log(`${C.b}${t`Vigía de API activo`}${C.x}`);
  console.log(t`Llama a ${watch.url} en lugar de ${watch.target}: las peticiones llegan igual a tu servidor y aquí verás cada respuesta.`);
  if (!o.target) console.log(C.dim + t`La URL del servidor se dedujo del proyecto (${guess.reason}). Usa --target para cambiarla.` + C.x);
  if (logs) console.log(C.dim + t`Leyendo errores de: ${o.logs.join(', ')}` + C.x);
  const stop = async () => { logs && logs.stop(); await watch.stop(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

function print(r, onlyNew) {
  const s = r.stats;
  console.log(`\n${C.b}Spectator${C.x} · ${r.name}   ${verdict(r.verdict)}`);
  console.log(C.dim + t`${s.sourceFiles} archivos · ${s.units} funciones · ${s.lines.toLocaleString(r.locale)} líneas` + ` · ${Object.keys(s.languages).join(', ') || t`Sin lenguajes reconocidos`} · ${r.durationMs} ms` + C.x);
  if (s.truncated) console.log(C.yel + t`Análisis parcial: se alcanzó el máximo de archivos` + C.x);
  for (const tool of s.tools.filter((x) => x.name !== 'tree-sitter' && (!x.ok || x.partial))) console.log(`${C.yel}${tool.name}: ${tool.partial ? t`parcial (${tool.detail})` : t`no ejecutado (${tool.detail})`}${C.x}`);
  console.log('');
  for (const c of r.categories) {
    const mark = c.fail ? `${C.red}●${C.x}` : c.human ? `${C.mag}●${C.x}` : c.risk ? `${C.yel}●${C.x}` : `${C.grn}●${C.x}`;
    const nums = [c.fail && `${c.fail} ${t`fallas`}`, c.risk && `${c.risk} ${t`riesgos`}`, c.human && `${c.human} ${t`decisiones`}`].filter(Boolean).join(', ');
    const pad = ' '.repeat(Math.max(1, 26 - [...c.label].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0)));
    console.log(`  ${mark} ${c.label}${pad}${nums || C.dim + t`sin avisos` + C.x}`);
  }
  const changed = (r.changes && r.changes.files) || [];
  if (changed.length) {
    console.log('\n  ' + C.b + t`Archivos con cambios sin confirmar: ${(r.changes.git && r.changes.git.total) || changed.length}` + C.x);
    for (const f of changed.slice(0, 10)) {
      const n = f.findings.fail + f.findings.risk + f.findings.human;
      console.log(`    ${f.rel}${f.added || f.removed ? ` ${C.grn}+${f.added}${C.x} ${C.red}−${f.removed}${C.x}` : ''}${n ? ' · ' + (n === 1 ? t`1 aviso` : t`${n} avisos`) : ''}${f.dependentsCount ? C.dim + ' · ' + (f.dependentsCount === 1 ? t`puede afectar a 1 archivo` : t`pueden afectar a ${f.dependentsCount} archivos`) + C.x : ''}`);
    }
  }
  console.log('\n  ' + t`Desde el punto de partida: +${r.delta.added} nuevos, ${r.delta.fixed} resueltos`);
  if (r.delta.comparison && r.delta.comparison !== 'comparable') console.log('  ' + C.yel + t`Comparación ${r.delta.comparison === 'partial' ? t`parcial` : t`no posible`}: ${r.delta.reasons.join(', ')}` + C.x);
  console.log('');
  const list = r.findings.filter((f) => !onlyNew || f.isNew);
  for (const f of list.slice(0, 40)) {
    console.log(`${sev(f.severity)}  ${f.title}${f.isNew ? ` ${C.b}[${t`nuevo`}]${C.x}` : ''}`);
    console.log(`        ${C.dim}${f.file}:${f.line} · ${f.tech}${C.x}`);
  }
  if (list.length > 40) console.log(C.dim + t`… y ${list.length - 40} más (usa --html o --json para verlos todos)` + C.x);
}

main().catch((e) => { console.error(e); process.exit(2); });
