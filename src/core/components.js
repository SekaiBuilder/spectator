'use strict';
// Un proyecto rara vez es un solo programa: suele tener varias partes (app, web, servidor…).
// Una carpeta es un componente si contiene el manifiesto de un ecosistema, o si el usuario la declara en spectator.json.
const fs = require('fs');
const nodePath = require('path');
const { readJson } = require('./util');

const MANIFESTS = [
  ['package.json', 'Node.js'], ['Package.swift', 'Swift'], ['pyproject.toml', 'Python'], ['setup.py', 'Python'], ['requirements.txt', 'Python'],
  ['go.mod', 'Go'], ['Cargo.toml', 'Rust'], ['pom.xml', 'Java'], ['build.gradle', 'JVM'], ['build.gradle.kts', 'JVM'],
  ['composer.json', 'PHP'], ['Gemfile', 'Ruby'], ['pubspec.yaml', 'Flutter'],
];
const SUFFIXES = [['.xcodeproj', 'Xcode'], ['.sln', '.NET'], ['.csproj', '.NET']];
const MAX_DEPTH = 5;

/** @returns [{path, name, kind, declared}] con rutas POSIX relativas, ordenadas. */
function detectComponents(root, files, cfg) {
  const dirs = new Set();
  for (const f of files) {
    const parts = f.rel.split('/');
    for (let i = 1; i < parts.length && i <= MAX_DEPTH; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const found = new Map();
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(nodePath.join(root, dir)); } catch { continue; }
    const names = new Set(entries);
    let kind = (MANIFESTS.find(([file]) => names.has(file)) || [])[1];
    if (!kind) kind = (SUFFIXES.find(([suffix]) => entries.some((e) => e.endsWith(suffix))) || [])[1];
    if (!kind) continue;
    const pkg = names.has('package.json') ? readJson(nodePath.join(root, dir, 'package.json'), {}) : null;
    found.set(dir, { path: dir, name: (pkg && typeof pkg.name === 'string' && pkg.name) || dir.split('/').pop(), kind, declared: false });
  }
  for (const c of cfg.components || []) {
    const dir = String(c.path).replace(/\/\*\*?$/, '').replace(/\/+$/, '');
    if (!dir || !dirs.has(dir)) continue;
    found.set(dir, { path: dir, name: c.name || dir.split('/').pop(), kind: (found.get(dir) || {}).kind || '', declared: true });
  }
  return [...found.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

module.exports = { detectComponents };
