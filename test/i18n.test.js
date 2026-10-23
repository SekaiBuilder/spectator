'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { extract } = require('../scripts/i18n-extract');
const { dictFor, setLocale } = require('../src/core/i18n');
const { Engine } = require('../src/core');

const placeholders = (s) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join();

test('todas las claves del código tienen inglés y japonés', () => {
  for (const lang of ['en', 'ja']) {
    const dict = dictFor(lang);
    for (const [key, file] of extract()) {
      if (!/[a-zA-Zá-úñ]{2}/.test(key.replace(/\{\d+\}/g, ''))) continue; // solo símbolos o valores: no se traduce
      assert.ok(dict[key], `[${lang}] falta la traducción de «${key.slice(0, 60)}» (${file})`);
      assert.strictEqual(placeholders(dict[key]), placeholders(key), `[${lang}] los {n} no coinciden en «${key.slice(0, 60)}»`);
    }
  }
});

test('el análisis sale traducido y las huellas no dependen del idioma', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-i18n-'));
  fs.cpSync(path.join(__dirname, '..', 'examples', 'restaurante'), root, { recursive: true, filter: (s) => !s.includes('.spectator') });
  const engine = new Engine(root);
  const es = await engine.scan({ locale: 'es' });
  const en = await engine.scan({ locale: 'en' });
  const ja = await engine.scan({ locale: 'ja' });
  setLocale('es');
  assert.deepStrictEqual(en.findings.map((f) => f.fingerprint).sort(), es.findings.map((f) => f.fingerprint).sort());
  assert.strictEqual(en.delta.added, 0, 'cambiar de idioma no crea avisos «nuevos»');
  assert.strictEqual(en.categories[0].label, 'Correctness');
  assert.strictEqual(ja.categories[1].label, 'セキュリティ');
  const spanish = /[áéíóúñ¿¡]| (el|la|los|las|que|una|del|está|sin|con) /i;
  for (const f of en.findings) for (const text of [f.title, f.why, f.action, ...f.evidence]) {
    if (f.rule === 'todo' || f.rule.startsWith('contract') || f.rule === 'inconsistent') continue; // incluyen texto del propio proyecto
    assert.ok(!spanish.test(text), `texto sin traducir en ${f.rule}: ${text}`);
  }
  assert.ok(ja.findings.every((f) => /[぀-ヿ一-鿿]/.test(f.title + f.why)), 'los avisos en japonés contienen japonés');
});
