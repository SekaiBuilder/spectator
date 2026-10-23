'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { indexExpress, expressFindings } = require('../src/core/express');
const { nodeConfigNeeds } = require('../src/core/noderun');
const { F } = require('../src/core/detectors');

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-express-'));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), src);
  }
  return root;
}

test('Express: rutas con prefijo de app.use y reglas estáticas', async () => {
  const root = project({
    'package.json': JSON.stringify({ dependencies: { express: '^4.21.0' } }),
    'src/app.js': "const express = require('express');\nconst items = require('./routes/items');\nconst app = express();\napp.use('/api/items', items);\napp.listen(process.env.PORT || 3000);\n",
    'src/routes/items.js': "const router = require('express').Router();\nconst db = [];\nrouter.get('/:id', (req, res) => {\n  res.json(db.find((x) => x.id === req.params.id));\n});\nrouter.post('/', async (req, res) => {\n  const { name } = req.body;\n  await save(name, process.env.SECRET_KEY);\n  res.status(201).json({ name });\n});\nmodule.exports = router;\n",
  });
  const idx = indexExpress(root);
  assert.deepStrictEqual(idx.endpoints.map((e) => `${e.method} ${e.path} ${e.file}:${e.line}`), ['GET /api/items/:id src/routes/items.js:3', 'POST /api/items src/routes/items.js:6']);
  assert.deepStrictEqual(idx.endpoints[1].fields, ['name']);
  const rules = new Set(expressFindings(root, F, idx).map((f) => f.rule));
  for (const r of ['express-no-json-parser', 'express-missing-404', 'express-no-validation', 'express-async-no-catch']) assert.ok(rules.has(r), r);
  const needs = await nodeConfigNeeds(root, idx);
  assert.ok(needs.some((n) => n.kind === 'deps'), 'sin node_modules pide npm install');
  const env = needs.find((n) => n.kind === 'env' && n.key === 'SECRET_KEY');
  assert.strictEqual(env.file, 'src/routes/items.js');
  assert.strictEqual(env.line, 8);
});
