'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { Engine } = require('../src/core');
const { writeJson } = require('../src/core/util');

function fixture(t, sources) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectator-incremental-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true}); fs.writeFileSync(path.join(root,file),text); };
  for (const [file,text] of Object.entries({'README.md':'Fixture',...sources})) write(file,text);
  return {root,write,engine:new Engine(root)};
}
async function matchesCold(engine, root, options) {
  const warm = await engine.scan(options), cold = await new Engine(root).scan(options);
  for (const key of ['graph','findings','statements','counts','delta']) assert.deepEqual(warm[key],cold[key],key);
  return warm;
}

test('reutiliza el grafo completo sin cambios y recalcula solo dependientes afectados', async (t) => {
  const {root,write,engine} = fixture(t, {
    'lib.js':'export function save() {}',
    'main.js':"import {save} from './lib'; export function main() { save(); }",
    'isolated.js':'export function isolated() {}',
  });
  await engine.scan();
  let result = await matchesCold(engine,root);
  assert.equal(result.stats.incremental.cacheHit,true);
  assert.equal(result.stats.localCacheHits,result.stats.files);
  write('lib.js','export function changed() {}');
  result = await matchesCold(engine,root);
  assert.equal(result.stats.incremental.updatedFiles,1);
  assert.equal(result.stats.incremental.callsResolved,2);
  assert.equal(result.stats.incremental.callsReused,1);
  assert.equal(result.graph.callEdges.length,0);
  // main.js no cambió, pero ahora importa un nombre que lib.js dejó de exportar: su aviso es nuevo y no puede salir de la caché.
  assert.ok(result.findings.some((f) => f.rule === 'broken-import' && f.file === 'main.js'));
  assert.equal(result.stats.localCacheHits,result.stats.files-2);
});

test('invalida reexportaciones transitivas, archivos añadidos y eliminados', async (t) => {
  const {root,write,engine} = fixture(t, {
    'lib.js':'export function save() {}',
    'barrel.js':"export {save} from './lib';",
    'main.js':"import {save} from './barrel'; export function main() { save(); }",
  });
  await engine.scan();
  write('lib.js','export function other() {}');
  assert.equal((await matchesCold(engine,root)).graph.callEdges.length,0);
  write('lib.js','export function save() {}');
  assert.equal((await matchesCold(engine,root)).graph.callEdges.length,1);
  fs.unlinkSync(path.join(root,'lib.js'));
  assert.equal((await matchesCold(engine,root)).graph.callEdges.length,0);
  write('lib.js','export function save() {}');
  assert.equal((await matchesCold(engine,root)).graph.callEdges.length,1);
});

test('detecta assets que aparecen o desaparecen aunque no sean archivos analizados', async (t) => {
  const {root,write,engine}=fixture(t,{'main.js':"import './style.css';"});
  assert.ok((await engine.scan()).findings.some((f)=>f.rule==='missing-import'));
  write('style.css','body {}');
  assert.ok(!(await matchesCold(engine,root)).findings.some((f)=>f.rule==='missing-import'));
  fs.unlinkSync(path.join(root,'style.css'));
  assert.ok((await matchesCold(engine,root)).findings.some((f)=>f.rule==='missing-import'));
});

test('invalida jerarquías y mutaciones sin perder equivalencia con un análisis nuevo', async (t) => {
  const {root,write,engine}=fixture(t,{
    'base.js':'export class Base { save() {} run() { this.save(); } }',
    'child.js':"import {Base} from './base'; export class Child extends Base {}",
  });
  await engine.scan();
  write('child.js',"import {Base} from './base'; export class Child extends Base { save() {} }");
  let result=await matchesCold(engine,root);
  assert.ok(result.graph.callEdges.some(([a,b])=>result.graph.units[a].id==='base.js#Base.run' && result.graph.units[b].id==='child.js#Child.save'));
  write('mutator.js','something.save = external;');
  result=await matchesCold(engine,root);
  assert.equal(result.graph.callEdges.length,0);
});

test('cambios de idioma, límites y exclusiones actualizan detectores locales', async (t) => {
  const {root,engine}=fixture(t,{'main.js':'export function calculate(a,b) { if(a) return b; return a; }'});
  await engine.scan({locale:'es'});
  await matchesCold(engine,root,{locale:'en'});
  writeJson(path.join(root,'spectator.json'),{limits:{params:1}});
  assert.ok((await matchesCold(engine,root,{locale:'es'})).findings.some((f)=>f.rule==='complex-function'));
  writeJson(path.join(root,'spectator.json'),{exclude:['main.js']});
  assert.equal((await matchesCold(engine,root)).graph.units.length,0);
});

test('detecta contenido nuevo con igual tamaño y mtime restaurado', async (t) => {
  const {root,write,engine} = fixture(t, {'main.js':'export function before() {}'});
  await engine.scan();
  const file = path.join(root,'main.js'), stat = fs.statSync(file);
  write('main.js','export function after_() {}');
  fs.utimesSync(file,stat.atime,stat.mtime);
  const result = await matchesCold(engine,root);
  assert.equal(result.stats.incremental.updatedFiles,1);
});

test('las exportaciones estrella invalidan llamadas al aparecer una ambigüedad', async (t) => {
  const {root,write,engine} = fixture(t, {
    'lib.js':'export function save() {}',
    'other.js':'export function other() {}',
    'barrel.js':"export * from './lib'; export * from './other';",
    'main.js':"import {save} from './barrel'; export function run() { save(); }",
  });
  assert.equal((await engine.scan()).graph.callEdges.length,1);
  write('other.js','export function save() {}');
  assert.equal((await matchesCold(engine,root)).graph.callEdges.length,0);
  write('other.js','export let save = external;');
  assert.equal((await matchesCold(engine,root)).graph.callEdges.length,0);
  write('other.js','export function other() {}');
  assert.equal((await matchesCold(engine,root)).graph.callEdges.length,1);
});
