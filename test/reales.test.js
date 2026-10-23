'use strict';
// Falsas alarmas y casos que se escapaban, encontrados al probar Spectator con proyectos reales (22 de octubre de 2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanText } = require('../src/core/textscan');
const { Engine } = require('../src/core');
const { project } = require('./helpers');

const sql = (src) => scanText({ rel: 'a.js', lang: 'javascript' }, src).security.filter((x) => x.rule === 'sql-concat').length;

test('SQL: unir textos fijos o listas de ? no es inyección; meter una variable sí', () => {
  assert.equal(sql("db.prepare(\n  'SELECT a FROM t ' +\n  'WHERE id = ? ' +\n  'LIMIT 1'\n);"), 0, 'consulta partida en varias líneas');
  assert.equal(sql("const m = ids.map(() => '?').join(',');\ndb.prepare(`DELETE FROM t WHERE id IN (${m})`).run(...ids);"), 0, 'lista de marcadores en una variable');
  assert.equal(sql("db.prepare(`UPDATE t SET a = 1 WHERE id IN (${found.map(() => '?').join(',')})`);"), 0, 'lista de marcadores en línea');
  assert.equal(sql("const kinds = \"kind IN ('a', 'b')\";\ndb.prepare(`SELECT COUNT(*) FROM events WHERE ${kinds} AND ts >= ?1`);"), 0, 'trozo de SQL fijo en una variable');
  assert.equal(sql("const scope = deck ? ' AND c.deck_id = ?' : '';\ndb.prepare(\n  'SELECT c.state FROM cards c ' +\n  'WHERE c.owner = ?' + scope +\n  ' GROUP BY c.state'\n);"), 0, 'elección entre dos textos fijos');
  assert.equal(sql("const clase = `language-select${compact ? ' x' : ''}`;"), 0, 'una clase CSS con «select» no es SQL');
  assert.equal(sql("db.prepare('SELECT a FROM t WHERE id = ' + id);"), 1);
  assert.equal(sql("q = 'SELECT a FROM t ' +\n  'WHERE name = ' + nombre;"), 1, 'la variable al final de varias líneas');
  assert.equal(sql("db.prepare(`SELECT * FROM t WHERE name = '${nombre}'`);"), 1, 'variable entre comillas dentro de la plantilla');
});

test('una clave en una prueba o en la documentación es un riesgo, no un fallo demostrado', async (t) => {
  const key = 'sk-' + 'proj' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
  const root = project(t, { 'src/app.js': `const k = '${key}';\n`, 'tests/app.test.js': `const k = '${key}';\n`, 'docs/uso.md': `Clave: ${key}\n` });
  const r = await new Engine(root).scan();
  const sev = (file) => (r.findings.find((f) => f.rule.startsWith('secret:') && f.file === file) || {}).severity;
  assert.equal(sev('src/app.js'), 'fail');
  assert.equal(sev('tests/app.test.js'), 'risk');
  assert.equal(sev('docs/uso.md'), 'risk');
});

test('los archivos de preparación y mocks de las pruebas no son «pruebas que no comprueban nada»', async (t) => {
  const root = project(t, {
    'src/a.ts': 'export function a() { return 1; }\n',
    'e2e/global-setup.ts': "import { a } from '../src/a';\nexport default async function setup() { a(); }\n",
    'src/tests/prisma-mock.ts': "import { a } from '../a';\nexport const mock = () => a();\n",
    'src/tests/a.test.ts': "import { a } from '../a';\ntest('a', () => { a(); });\n",
  });
  const r = await new Engine(root).scan();
  assert.deepEqual(r.findings.filter((f) => f.rule === 'no-assert').map((f) => f.file), ['src/tests/a.test.ts']);
});

// Encontrados al preparar las capturas en inglés con full-stack-fastapi-template (23 de octubre de 2026).
test('una URL de conexión que toma la contraseña de una variable no es una credencial escrita', () => {
  const secrets = (src) => scanText({ rel: '.env', lang: null }, src).secrets.length;
  assert.equal(secrets('DATABASE_URL=postgresql://postgres:${POSTGRES_PASSWORD}@localhost:5432/app\n'), 0);
  assert.equal(secrets('DATABASE_URL=postgresql://postgres:Sup3rS3cret2026@localhost:5432/app\n'), 1);
});

test('ocultar «password123» no tapa la palabra password de otros textos', () => {
  const { redactResult } = require('../src/core/textscan');
  const r = redactResult({ a: 'POST /reset-password', b: 'password', c: "login('ana', 'password12" }, ['password123']);
  assert.equal(r.a, 'POST /reset-password');
  assert.equal(r.b, 'password');
  assert.equal(r.c, "login('ana', '[REDACTED]", 'un fragmento cortado en mitad de la credencial sigue oculto');
});

test('los ayudantes en su propia carpeta (tests/utils/) no son «pruebas que no comprueban nada»', async (t) => {
  const root = project(t, {
    'app/a.py': 'def a():\n    return 1\n',
    'tests/utils/user.py': 'from app.a import a\n\ndef make_user():\n    return a()\n',
    'tests/test_a.py': 'from app.a import a\n\ndef test_a():\n    a()\n',
  });
  const r = await new Engine(root).scan();
  const noAssert = r.findings.filter((f) => f.rule === 'testing/no-assert' || f.rule === 'no-assert').map((f) => f.file);
  assert.deepEqual(noAssert, ['tests/test_a.py']);
});

test('FastAPI: SessionDep y otros alias de Depends no llegan en la petición; el resumen se traduce', (t) => {
  const { backendMap } = require('../src/core/backend');
  const { F } = require('../src/core/detectors');
  const { setLocale } = require('../src/core/i18n');
  const root = project(t, {
    'requirements.txt': 'fastapi\n',
    'app/deps.py': 'from typing import Annotated\nfrom fastapi import Depends\nfrom sqlmodel import Session\n\ndef get_db():\n    yield None\n\nSessionDep = Annotated[Session, Depends(get_db)]\n',
    'app/main.py': 'import uuid\nfrom fastapi import FastAPI\nfrom app.deps import SessionDep\n\napp = FastAPI()\n\n@app.get("/items/{id}")\ndef read_item(session: SessionDep, id: uuid.UUID, q: str = ""):\n    return {}\n',
  });
  setLocale('en');
  try {
    const e = backendMap(root, F).endpoints.find((x) => x.id === 'GET /items/{id}');
    assert.deepEqual(e.inputs.map((i) => i.name), ['id', 'q']);
    assert.match(e.summary, /in the URL and q as a parameter/);
    assert.doesNotMatch(e.example.curl, /texto/);
  } finally { setLocale('es'); }
});
