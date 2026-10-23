'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../src/core');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectator-benchmark-'));
  try {
    fs.writeFileSync(path.join(root, 'README.md'), 'Synthetic benchmark');
    const body = Array.from({ length: 60 }, (_, i) => `  total += values[${i}] * ${i + 1};`).join('\n');
    for (let i = 0; i < 500; i++) {
      fs.writeFileSync(path.join(root, `f${i}.js`), `export function calculate${i}(values) {\n let total = 0;\n${body}\n return total;\n}\n`);
    }
    const engine = new Engine(root);
    const rows = [];
    for (let run = 1; run <= 4; run++) {
      if (run === 3) fs.appendFileSync(path.join(root, 'f0.js'), '\nexport function added() { return 1; }\n');
      const result = await engine.scan();
      rows.push({ run, scenario: run === 1 ? 'cold' : run === 3 ? 'one file edited' : 'unchanged', files: result.stats.sourceFiles, lines: result.stats.lines, totalMs: result.durationMs,
        graphMs: Number(result.stats.timings.graphMs.toFixed(3)), callsReused: result.stats.incremental.callsReused,
        localCacheHits: result.stats.localCacheHits,
        duplicationMs: Number(result.stats.timings.duplicationMs.toFixed(3)), duplicationCacheHit: result.stats.duplicationCacheHit });
    }
    console.table(rows);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
