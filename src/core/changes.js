'use strict';
// Qué está cambiando en el proyecto, venga el cambio de VS Code, de otro editor (IntelliJ, Xcode…) o de una herramienta:
// - entre dos análisis del mismo motor, comparando el contenido de cada archivo;
// - respecto al último commit, si el proyecto usa Git.
// A cada archivo cambiado se le añade su posible impacto: qué otros archivos dependen de él según las conexiones estáticas.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_FILES = 100;

/** Archivos añadidos, modificados o eliminados entre dos mapas rel → huella de contenido. */
function diffHashes(prev, now) {
  if (!prev) return [];
  const out = [];
  for (const [rel, h] of now) if (!prev.has(rel)) out.push({ rel, kind: 'added' }); else if (prev.get(rel) !== h) out.push({ rel, kind: 'modified' });
  for (const rel of prev.keys()) if (!now.has(rel)) out.push({ rel, kind: 'removed' });
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

const git = (root, args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 4000, maxBuffer: 8 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};
const STATUS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'added', U: 'conflict', '?': 'untracked' };

/** Cambios sin confirmar respecto al último commit. null si la carpeta no está en un repositorio Git o Git no está disponible. */
function gitChanges(root) {
  if (!fs.existsSync(root)) return null;
  const prefix = git(root, ['rev-parse', '--show-prefix']);
  if (prefix == null) return null;
  const branch = (git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim() || null;
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  if (status == null) return null;
  const strip = (p) => (prefix.trim() && p.startsWith(prefix.trim()) ? p.slice(prefix.trim().length) : p);
  const files = new Map();
  const parts = status.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2), rel = strip(entry.slice(3));
    if (code[0] === 'R' || code[0] === 'C') i++; // el nombre anterior viene a continuación
    const letter = code === '??' ? '?' : code.includes('U') ? 'U' : code[0] !== ' ' ? code[0] : code[1];
    files.set(rel, { rel, status: STATUS[letter] || 'modified', added: 0, removed: 0 });
  }
  // Líneas añadidas y quitadas (cambios preparados y sin preparar juntos). Sin commits todavía, no hay con qué comparar.
  const numstat = git(root, ['diff', '--numstat', 'HEAD', '--', '.']);
  for (const line of (numstat || '').split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const f = files.get(strip(m[3]));
    if (f) { f.added = m[1] === '-' ? 0 : Number(m[1]); f.removed = m[2] === '-' ? 0 : Number(m[2]); }
  }
  for (const f of files.values()) {
    if (f.status !== 'untracked' || f.added) continue;
    try { f.added = fs.readFileSync(path.join(root, f.rel), 'utf8').split('\n').length; } catch { /* binario o ilegible */ }
  }
  const list = [...files.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return { branch, total: list.length, files: list.slice(0, MAX_FILES), truncated: list.length > MAX_FILES };
}

/**
 * Archivos que dependen (directa o indirectamente) de cada archivo cambiado, siguiendo las conexiones estáticas al revés.
 * Recorrido acotado: profundidad 3 y 200 archivos. Si se corta, se dice. No demuestra que el cambio les afecte.
 */
function dependentsOf(rel, reverse, maxDepth = 3, maxNodes = 200) {
  const seen = new Set([rel]);
  let frontier = [rel], truncated = false;
  for (let depth = 0; frontier.length; depth++) {
    const next = [];
    for (const id of frontier) for (const dep of reverse.get(id) || []) {
      if (seen.has(dep)) continue;
      if (depth >= maxDepth || seen.size > maxNodes) { truncated = true; continue; }
      seen.add(dep); next.push(dep);
    }
    frontier = next;
  }
  seen.delete(rel);
  return { dependents: [...seen], truncated };
}

/**
 * Une los cambios entre análisis y los de Git en una sola lista por archivo, con sus avisos actuales,
 * los avisos nuevos o desaparecidos desde el análisis anterior y su posible impacto.
 */
function describeChanges({ prevHashes, hashes, prevFindings, findings, fileEdges, git: gitInfo }) {
  const reverse = new Map();
  for (const [from, tos] of fileEdges) for (const to of tos) (reverse.get(to) || reverse.set(to, []).get(to)).push(from);
  const byFile = new Map();
  const entry = (rel) => byFile.get(rel) || byFile.set(rel, { rel }).get(rel);
  for (const c of diffHashes(prevHashes, hashes)) entry(c.rel).sinceLastScan = c.kind;
  for (const g of (gitInfo && gitInfo.files) || []) Object.assign(entry(g.rel), { git: g.status, added: g.added, removed: g.removed });
  const before = new Set((prevFindings || []).map((f) => f.fingerprint));
  const now = new Set(findings.map((f) => f.fingerprint));
  const out = [];
  for (const e of byFile.values()) {
    const mine = findings.filter((f) => f.file === e.rel);
    e.findings = { fail: 0, risk: 0, human: 0 };
    for (const f of mine) e.findings[f.severity]++;
    if (prevFindings && e.sinceLastScan) {
      e.newFindings = mine.filter((f) => !before.has(f.fingerprint)).map((f) => ({ id: f.id, title: f.title, severity: f.severity, line: f.line }));
      e.fixedFindings = prevFindings.filter((f) => f.file === e.rel && !now.has(f.fingerprint)).map((f) => ({ title: f.title, severity: f.severity }));
    }
    const impact = dependentsOf(e.rel, reverse);
    e.dependents = impact.dependents.slice(0, 20);
    e.dependentsCount = impact.dependents.length;
    e.dependentsTruncated = impact.truncated;
    out.push(e);
  }
  out.sort((a, b) => (!!b.sinceLastScan - !!a.sinceLastScan) || (a.rel < b.rel ? -1 : 1));
  return { files: out.slice(0, MAX_FILES), total: out.length, truncated: out.length > MAX_FILES };
}

module.exports = { diffHashes, gitChanges, dependentsOf, describeChanges };
