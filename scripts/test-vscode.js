'use strict';
// Ejecuta test/vscode/suite.js dentro del VS Code instalado, con un perfil y extensiones temporales
// para no tocar tu configuración. Uso: npm run test:vscode
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectator-vscode-'));
const project = path.join(tmp, 'proyecto');
fs.cpSync(path.join(root, 'examples', 'restaurante'), project, { recursive: true, filter: (s) => !s.includes('.spectator') });
const git = (...args) => spawnSync('git', args, { cwd: project, stdio: 'ignore' });
git('init', '-q'); git('add', '-A'); git('-c', 'user.email=test@spectator', '-c', 'user.name=test', 'commit', '-qm', 'base');
// Segunda carpeta en la misma ventana (FIX-06): un backend FastAPI. Se abre como área de trabajo de dos carpetas
// desde el principio, porque añadir una carpeta a una ventana ya abierta reinicia las extensiones.
const second = path.join(tmp, 'api-python');
fs.cpSync(path.join(root, 'examples', 'tienda-fastapi'), second, { recursive: true, filter: (s) => !s.includes('.spectator') });
const workspace = path.join(tmp, 'dos-carpetas.code-workspace');
fs.writeFileSync(workspace, JSON.stringify({ folders: [{ path: project }, { path: second }] }));
const out = path.join(tmp, 'results.json');
const code = process.env.VSCODE_CLI || 'code';
const r = spawnSync(code, [
  '--new-window', '--wait', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
  `--user-data-dir=${path.join(tmp, 'user')}`, `--extensions-dir=${path.join(tmp, 'ext')}`,
  `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(root, 'test', 'vscode', 'suite.js')}`, workspace,
], { stdio: 'inherit', env: { ...process.env, SPECTATOR_TEST_OUT: out } });
let results = [];
try { results = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* VS Code no llegó a ejecutar la suite */ }
for (const t of results) console.log(`${t.ok ? '✔' : '✖'} ${t.name} (${t.ms} ms)${t.ok ? '' : '\n  ' + t.error}`);
const ok = results.length && results.every((t) => t.ok);
console.log(ok ? `\n${results.length} de ${results.length} pruebas en VS Code real` : `\nFallo (código ${r.status}); resultados en ${out}`);
process.exit(ok ? 0 : 1);
