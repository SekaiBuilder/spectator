'use strict';
// Sensores externos opcionales (análisis profundo). Se ejecutan como procesos aparte y sus resultados
// se normalizan al formato de hallazgo común. Si una herramienta no está instalada, se informa y se sigue.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { F } = require('./detectors');
const { t } = require('./i18n');

function run(cmd, args, cwd, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      resolve({ missing: !!(err && err.code === 'ENOENT'), stdout: stdout || '', stderr: stderr || '', failed: !!err, code: err ? (Number.isInteger(err.code) ? err.code : null) : 0 });
    });
  });
}
const rel = (root, p) => path.relative(root, path.resolve(root, p)).split(path.sep).join('/');
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// Presupuesto de npm audit: cada carpeta es una consulta de red de hasta 90 s. Lo que no entra se publica como pendiente.
const NPM_AUDIT_BUDGET = 5;
const SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical']);

async function npmAudit(root, files) {
  const out = [];
  const dirs = files.filter((f) => path.basename(f.rel) === 'package-lock.json' || path.basename(f.rel) === 'package.json').map((f) => path.dirname(f.abs));
  const all = [...new Set(dirs)].filter((d) => fs.existsSync(path.join(d, 'package-lock.json')));
  if (!all.length) return { tool: { name: 'npm audit', ok: false, detail: t`no hay package-lock.json` }, findings: out };
  const withLock = all.slice(0, NPM_AUDIT_BUDGET);
  const name = (dir) => rel(root, dir) || '.';
  const scope = { total: all.length, done: [], failed: [], pending: all.slice(NPM_AUDIT_BUDGET).map(name) };
  for (const dir of withLock) {
    const r = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--json'], dir, 90000);
    if (r.missing) return { tool: { name: 'npm audit', ok: false, detail: t`npm no está instalado` }, findings: out };
    // Una carpeta solo cuenta como auditada si el informe tiene la forma esperada en todas sus entradas y el proceso
    // terminó con 0 (sin vulnerabilidades) o con 1 (con vulnerabilidades). Cualquier otro final es un fallo de la herramienta.
    const j = parse(r.stdout);
    const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const entries = object(j) && !j.error && object(j.vulnerabilities) ? Object.entries(j.vulnerabilities) : null;
    const valid = entries && entries.every(([, v]) => object(v) && SEVERITIES.has(v.severity) && (v.via === undefined || Array.isArray(v.via)));
    if (!valid || !(r.code === 0 || (r.code === 1 && entries.length))) { scope.failed.push(name(dir)); continue; }
    scope.done.push(name(dir));
    for (const [name, v] of entries) {
      const adv = (v.via || []).find((x) => object(x)) || {};
      const severe = v.severity === 'critical' || v.severity === 'high';
      out.push(F('dependencies', 'cve', severe ? 'fail' : 'risk', rel(root, path.join(dir, 'package.json')), 1, 'cve:' + name, {
        source: 'npm audit', confidence: 95, title: t`La librería «${name}» tiene una vulnerabilidad conocida (${v.severity})`,
        why: adv.title || t`Existe un fallo de seguridad público en la versión instalada. Los atacantes conocen estos fallos.`,
        action: v.fixAvailable ? t`Actualizar la librería (npm audit fix).` : t`No hay arreglo automático: valorar sustituir la librería.`,
        tech: t`${name} ${v.range || ''} · ${adv.url || ''}`.trim(), evidence: [t`Base de datos de avisos de npm`, adv.url || t`Rango afectado: ${v.range}`],
      }));
    }
  }
  // Solo es un resultado completo si se auditaron todas las carpetas con dependencias; lo demás se declara.
  if (!scope.done.length) return { tool: { name: 'npm audit', ok: false, detail: t`no devolvió resultados (¿sin red?)`, scope }, findings: out };
  const partial = scope.done.length < scope.total;
  const gaps = [
    scope.pending.length ? t`sin auditar por límite de ${NPM_AUDIT_BUDGET}: ${scope.pending.join(', ')}` : '',
    scope.failed.length ? t`sin respuesta: ${scope.failed.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  const detail = partial ? t`${scope.done.length} de ${scope.total} carpetas con dependencias auditadas` + ' (' + gaps + ')' : t`vulnerabilidades en dependencias`;
  return { tool: { name: 'npm audit', ok: !partial, partial, detail, scope }, findings: out };
}

async function gitleaks(root) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectator-gitleaks-'));
  const report = path.join(temp, 'report.json');
  let r, j;
  try {
    r = await run('gitleaks', ['detect', '--no-git', '--redact', '--source', root, '--report-format', 'json', '--report-path', report, '--exit-code', '0']);
    j = parse(fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  if (r.missing) return { tool: { name: 'gitleaks', ok: false, detail: t`no instalado` }, findings: [] };
  const valid = Array.isArray(j) && j.every((x) => x && typeof x.File === 'string' && typeof x.RuleID === 'string' && Number.isInteger(x.StartLine));
  const ok = !r.failed && valid;
  return {
    tool: { name: 'gitleaks', ok, detail: ok ? t`secretos` : t`La herramienta falló o no produjo un informe válido.` },
    findings: (valid ? j : []).filter((x) => !/node_modules|\.spectator/.test(x.File || '')).map((x) => F('security', 'gitleaks:' + x.RuleID, 'fail', rel(root, x.File), x.StartLine, x.RuleID + ':' + x.StartLine, {
      source: 'gitleaks', confidence: 90, title: t`Credencial expuesta: ${x.Description || x.RuleID}`,
      why: t`Cualquiera con acceso al código puede usarla.`, action: t`Moverla a una variable de entorno y rotarla.`, tech: t`gitleaks · ${x.RuleID}`,
      evidence: [t`Detectado por gitleaks (regla ${x.RuleID})`],
    })),
  };
}

async function osvScanner(root) {
  let r = await run('osv-scanner', ['scan', 'source', '-r', '--format', 'json', root]);
  if (r.missing) return { tool: { name: 'osv-scanner', ok: false, detail: t`no instalado` }, findings: [] };
  let j = parse(r.stdout);
  if (!j) { r = await run('osv-scanner', ['--format', 'json', '-r', root]); j = parse(r.stdout); }
  // Que la salida sea JSON no basta: tiene que ser un informe de OSV y el proceso tiene que haber terminado bien.
  // osv-scanner sale con 0 (sin vulnerabilidades) o 1 (con ellas); cualquier otro código es un fallo de la herramienta.
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const valid = object(j) && Array.isArray(j.results) && j.results.every((res) => object(res)
    && (res.packages === undefined || (Array.isArray(res.packages) && res.packages.every((p) => object(p)
      && (p.vulnerabilities === undefined || (Array.isArray(p.vulnerabilities) && p.vulnerabilities.every((v) => object(v) && typeof v.id === 'string')))))));
  const found = valid && j.results.some((res) => (res.packages || []).some((p) => (p.vulnerabilities || []).length));
  if (r.code === 128 && !found) return { tool: { name: 'osv-scanner', ok: false, detail: t`no encontró dependencias que analizar` }, findings: [] };
  const ok = valid && (r.code === 0 || (r.code === 1 && found));
  if (!ok) return { tool: { name: 'osv-scanner', ok: false, detail: t`La herramienta falló o no produjo un informe válido.` }, findings: [] };
  const out = [];
  for (const res of j.results) {
    for (const p of res.packages || []) {
      for (const v of p.vulnerabilities || []) {
        out.push(F('dependencies', 'cve', 'fail', rel(root, res.source?.path || 'package.json'), 1, v.id + ':' + p.package?.name, {
          source: 'osv-scanner', confidence: 95, title: t`La librería «${p.package?.name}» tiene una vulnerabilidad conocida`,
          why: v.summary || t`Existe un fallo de seguridad público en la versión instalada.`, action: t`Actualizar a una versión corregida.`,
          tech: t`${v.id} · ${p.package?.name}@${p.package?.version}`, evidence: [t`OSV: ${v.id}`],
        }));
      }
    }
  }
  return { tool: { name: 'osv-scanner', ok: true, detail: t`vulnerabilidades (todos los ecosistemas)` }, findings: out };
}

async function runAdapters(root, files) {
  // Si una herramienta falla de forma inesperada, conserva su nombre: un fallo anónimo no se puede atribuir ni repetir.
  const sensors = [['npm audit', () => npmAudit(root, files)], ['gitleaks', () => gitleaks(root)], ['osv-scanner', () => osvScanner(root)]];
  const results = await Promise.all(sensors.map(([name, start]) => Promise.resolve().then(start).catch((e) => ({ tool: { name, ok: false, detail: String((e && e.message) || e) }, findings: [] }))));
  // Avisos repetidos se juntan solo si coinciden también en el archivo: el mismo paquete en dos proyectos son dos avisos.
  const seen = new Set();
  const findings = results.flatMap((r) => r.findings).filter((f) => { const k = [f.category, f.file, f.title].join('\u0001'); if (seen.has(k)) return false; seen.add(k); return true; });
  return { findings, tools: results.map((r) => r.tool) };
}

module.exports = { runAdapters };
