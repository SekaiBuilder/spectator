'use strict';
// Cronología: qué archivos del proyecto cambiaron hoy, cuándo y quién los cambió.
//
// «Quién» solo se afirma con evidencia:
// - los registros locales de asistentes de IA que guardan cada edición con su hora (Claude Code, Codex);
// - los commits de Git firmados por una herramienta de IA (Co-Authored-By, autor «(aider)», etc.);
// - lo que Spectator vio cambiar mientras estaba abierto (guardado en VS Code o desde otro editor).
// Si una herramienta no deja registro (Copilot, Cursor y otras), el cambio queda como «sin IA detectada»:
// nunca se adivina. De los registros de IA solo se leen la ruta, la hora y el fragmento cambiado, nunca la conversación.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { relativeInside } = require('./util');

const SNIPPET = 2000;
const lines = (s) => (s ? String(s).split('\n').length : 0);
const clip = (s) => (s == null ? null : String(s).length > SNIPPET ? String(s).slice(0, SNIPPET) + '\n…' : String(s));
const cache = new Map(); // archivo de registro → { mtimeMs, size, edits }

function readCached(file, parse) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.edits;
  let edits = [];
  if (st.size <= 120 * 1024 * 1024) { try { edits = parse(fs.readFileSync(file, 'utf8')); } catch { edits = []; } }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, edits });
  return edits;
}

// ───────────────────────── Claude Code: ~/.claude/projects/<carpeta codificada>/<sesión>.jsonl
/** Ediciones (Edit, MultiEdit, Write, NotebookEdit) que se aplicaron: las rechazadas o fallidas no cuentan. */
function parseClaude(text) {
  const uses = [], failed = new Set();
  for (const line of text.split('\n')) {
    if (line.includes('"tool_result"') && line.includes('"is_error":true')) {
      try { for (const c of JSON.parse(line).message.content || []) if (c && c.type === 'tool_result' && c.is_error) failed.add(c.tool_use_id); } catch { /* línea parcial */ }
      continue;
    }
    if (!line.includes('"tool_use"') || !/"name":"(Edit|MultiEdit|Write|NotebookEdit|Bash)"/.test(line)) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    for (const c of (d.message && d.message.content) || []) {
      // Órdenes de terminal: no dicen qué archivo cambian, pero sirven de pista para atribuir un cambio observado.
      if (c && c.type === 'tool_use' && c.name === 'Bash' && c.input && typeof c.input.command === 'string') {
        uses.push({ id: c.id, kind: 'command', agent: 'Claude Code', at: d.timestamp, cwd: d.cwd || null, command: c.input.command.slice(0, 600) });
        continue;
      }
      if (!c || c.type !== 'tool_use' || !/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(c.name)) continue;
      const inp = c.input || {};
      const file = inp.file_path || inp.notebook_path;
      if (!file) continue;
      const pairs = c.name === 'MultiEdit' ? (inp.edits || []) : c.name === 'Edit' ? [inp] : [];
      uses.push({
        id: c.id, agent: 'Claude Code', at: d.timestamp, abs: file, session: d.sessionId || null,
        action: c.name === 'Write' ? 'write' : 'edit',
        before: clip(pairs.map((p) => p.old_string).filter((x) => x != null).join('\n…\n')) || null,
        after: clip(c.name === 'Write' ? inp.content : pairs.map((p) => p.new_string).filter((x) => x != null).join('\n…\n')),
        removed: pairs.reduce((n, p) => n + lines(p.old_string), 0), added: c.name === 'Write' ? lines(inp.content) : pairs.reduce((n, p) => n + lines(p.new_string), 0),
      });
    }
  }
  return uses.filter((u) => !failed.has(u.id));
}
function claudeDirs(root, home) {
  const base = path.join(home, '.claude', 'projects');
  const enc = root.replace(/[^A-Za-z0-9]/g, '-');
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return []; }
  // La sesión pudo empezar en esta carpeta, en una superior o en una subcarpeta.
  return dirs.filter((d) => d === enc || enc.startsWith(d + '-') || d.startsWith(enc + '-')).map((d) => path.join(base, d));
}

// ───────────────────────── Codex: ~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl
function parseCodex(text) {
  const out = [];
  let cwd = null;
  const results = new Map();
  const calls = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (!cwd && line.includes('"session_meta"')) { try { cwd = JSON.parse(line).payload.cwd || null; } catch { /* sigue */ } continue; }
    if (line.includes('_output"') && line.includes('"call_id"')) {
      try { const p = JSON.parse(line).payload; if (p && p.call_id) results.set(p.call_id, JSON.stringify(p.output || '')); } catch { /* sigue */ }
      continue;
    }
    if (!line.includes('*** ') || !/File: /.test(line)) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    const patch = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p);
    calls.push({ at: d.timestamp, callId: p.call_id || null, patch });
  }
  for (const c of calls) {
    const res = c.callId ? results.get(c.callId) || '' : '';
    if (/verification failed|error applying|failed to apply|No such file/i.test(res)) continue;
    // Un parche puede tocar varios archivos: cada bloque empieza por «*** Update|Add|Delete File: ruta».
    const text = c.patch.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    const blocks = text.split(/\*\*\* (?=(?:Update|Add|Delete) File: )/).slice(1);
    for (const b of blocks) {
      const m = /^(Update|Add|Delete) File: ([^\n]+)/.exec(b);
      if (!m) continue;
      const body = b.slice(m[0].length).split(/\n\*\*\* (?:End Patch|Move to:)/)[0];
      const removed = body.split('\n').filter((l) => l.startsWith('-')).map((l) => l.slice(1));
      const added = body.split('\n').filter((l) => l.startsWith('+')).map((l) => l.slice(1));
      const file = m[2].trim();
      out.push({
        agent: 'Codex', at: c.at, abs: path.isAbsolute(file) ? file : path.resolve(cwd || '/', file),
        action: m[1] === 'Add' ? 'create' : m[1] === 'Delete' ? 'delete' : 'edit',
        before: clip(removed.join('\n')) || null, after: clip(added.join('\n')) || null, removed: removed.length, added: added.length,
      });
    }
  }
  return out;
}
function codexFiles(home, sinceMs) {
  const base = path.join(home, '.codex', 'sessions');
  const out = [];
  for (let d = new Date(sinceMs); d.getTime() <= Date.now() + 864e5; d = new Date(d.getTime() + 864e5)) {
    const dir = path.join(base, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (n.endsWith('.jsonl')) out.push(path.join(dir, n));
  }
  return out;
}

// ───────────────────────── Git: commits firmados por herramientas de IA
const GIT_AGENTS = [
  [/Generated with \[?Claude Code|Co-Authored-By:\s*Claude|noreply@anthropic\.com/i, 'Claude Code'],
  [/\(aider\)|^aider:/im, 'Aider'],
  [/Co-authored-by:.*Copilot|copilot-swe-agent|github-copilot/i, 'GitHub Copilot'],
  [/Co-authored-by:.*Cursor|cursoragent|cursor\.com/i, 'Cursor'],
  [/Co-authored-by:.*(Codex|OpenAI)|codex@openai/i, 'Codex'],
  [/Co-authored-by:.*Gemini|gemini-code-assist/i, 'Gemini'],
  [/devin-ai-integration|Co-authored-by:.*Devin/i, 'Devin'],
  [/Co-authored-by:.*Windsurf|codeium/i, 'Windsurf'],
];
function gitAiCommits(root, sinceMs) {
  const r = spawnSync('git', ['log', `--since=${new Date(sinceMs).toISOString()}`, '--name-status', '--format=%x1e%H%x1f%an <%ae>%x1f%aI%x1f%B%x1f', '--', '.'], { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return [];
  const top = (spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).stdout || '').trim();
  const out = [];
  for (const rec of r.stdout.split('\x1e').slice(1)) {
    const [hash, author, date, msg, files] = rec.split('\x1f');
    // Solo cuentan el autor y las firmas del commit (Co-authored-by, «Generated with…», prefijo «aider:»),
    // no el texto libre: un mensaje que habla de Claude Code no lo convierte en autor.
    const lines_ = String(msg || '').split('\n');
    const signed = lines_.filter((l) => /^\s*(Co-authored-by|Signed-off-by):/i.test(l) || /^\s*(🤖\s*)?Generated with\b/i.test(l));
    const evidence = [author, ...signed, /^aider:/i.test(lines_[0] || '') ? 'aider:' : ''].join('\n');
    const hit = GIT_AGENTS.find(([re]) => re.test(evidence));
    if (!hit) continue;
    for (const l of (files || '').split('\n')) {
      const m = /^([AMDR])\d*\t(?:[^\t]+\t)?(.+)$/.exec(l.trim());
      if (!m) continue;
      out.push({ agent: hit[1], at: date, abs: path.join(top || root, m[2]), action: m[1] === 'A' ? 'create' : m[1] === 'D' ? 'delete' : 'edit', commit: hash.slice(0, 8), message: msg.split('\n')[0].slice(0, 120), via: 'git' });
    }
  }
  return out;
}

/** Medianoche local de hoy, en milisegundos. */
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * Ediciones de IA a archivos de `root` desde `since`.
 * @returns [{agent, at, file, action, added, removed, before, after, via}]
 */
function aiEdits(root, { since = startOfToday(), home = os.homedir(), logs = true } = {}) {
  const out = [];
  // En Windows la carpeta puede llegar con nombre corto (RUNNER~1) y Git la devuelve con el largo: se comparan rutas reales.
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
  const realRoot = real(root);
  // Un archivo borrado no tiene ruta real: se usa la de su carpeta.
  const realOf = (abs) => real(abs) || (real(path.dirname(abs)) ? path.join(real(path.dirname(abs)), path.basename(abs)) : abs);
  const inside = (abs) => relativeInside(root, abs) || (realRoot && (relativeInside(realRoot, abs) || relativeInside(realRoot, realOf(abs))));
  const commands = [];
  const keep = (e, via) => {
    const t = Date.parse(e.at);
    if (e.kind === 'command') {
      // Solo órdenes lanzadas dentro del proyecto (o en una carpeta que lo contiene).
      if (t >= since && e.cwd && (relativeInside(e.cwd, root) || path.resolve(e.cwd) === path.resolve(root) || relativeInside(root, e.cwd))) commands.push({ agent: e.agent, at: e.at, command: e.command, via: 'claude-bash' });
      return;
    }
    const rel = inside(e.abs);
    if (!rel || !(t >= since)) return;
    out.push({ ...e, abs: undefined, file: rel.split(path.sep).join('/'), via: e.via || via });
  };
  if (logs) {
    for (const dir of claudeDirs(root, home)) {
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
      for (const n of names) {
        const file = path.join(dir, n);
        try { if (fs.statSync(file).mtimeMs < since) continue; } catch { continue; }
        for (const e of readCached(file, parseClaude)) keep(e, 'claude-log');
      }
    }
    for (const file of codexFiles(home, since)) for (const e of readCached(file, parseCodex)) keep(e, 'codex-log');
  }
  for (const e of gitAiCommits(root, since)) keep(e, 'git');
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // Las órdenes de terminal viajan aparte (no son ediciones): chronology() las usa como pista.
  Object.defineProperty(out, 'commands', { value: commands, enumerable: false });
  return out;
}

/**
 * Cronología del día: une lo que Spectator vio cambiar con las ediciones de IA. Un cambio visto por Spectator se
 * atribuye a una IA si esa IA editó el mismo archivo entre 2 minutos antes y 15 segundos después.
 * @param observed [{at, file, source: 'vscode'|'external', kind, newFindings}]
 */
function chronology({ observed = [], ai = [], commands = ai.commands || [] }) {
  const entries = ai.map((e) => ({ ...e, who: e.agent, source: e.via, certainty: 'confirmed' }));
  for (const o of observed) {
    const t = Date.parse(o.at);
    const match = entries.find((e) => e.file === o.file && !e.observed && Date.parse(e.at) >= t - 120000 && Date.parse(e.at) <= t + 15000);
    if (match) { match.observed = true; match.newFindings = o.newFindings || []; continue; }
    // Pista: una IA lanzó por terminal una orden que nombra este archivo justo antes del cambio (sed -i, cat >, un script…).
    // Se marca como probable, no como seguro.
    const name = o.file.split('/').pop();
    const cmd = commands.filter((c) => Date.parse(c.at) >= t - 120000 && Date.parse(c.at) <= t + 15000 && (c.command.includes(o.file) || c.command.includes(name)))
      .sort((a, b) => Math.abs(Date.parse(a.at) - t) - Math.abs(Date.parse(b.at) - t))[0];
    entries.push({
      at: o.at, file: o.file, who: cmd ? cmd.agent : null, source: cmd ? cmd.via : o.source, certainty: cmd ? 'probable' : null, command: cmd ? cmd.command : null,
      action: o.kind === 'added' ? 'create' : o.kind === 'removed' ? 'delete' : 'edit', newFindings: o.newFindings || [], observed: true,
    });
  }
  entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const byAgent = {};
  for (const e of entries) { const k = e.who || ''; (byAgent[k] || (byAgent[k] = { edits: 0, files: new Set() })).edits++; byAgent[k].files.add(e.file); }
  return {
    entries: entries.slice(0, 500),
    total: entries.length,
    agents: Object.entries(byAgent).map(([who, v]) => ({ who: who || null, edits: v.edits, files: v.files.size })).sort((a, b) => b.edits - a.edits || (!!b.who - !!a.who)),
  };
}

module.exports = { aiEdits, chronology, parseClaude, parseCodex, startOfToday, gitAiCommits };
