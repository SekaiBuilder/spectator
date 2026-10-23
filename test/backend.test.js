'use strict';
// Mapa del backend: lo que ve quien empieza tiene que coincidir con lo que hace el código.
// examples/tienda-spring es un backend con respuestas conocidas (y errores típicos de IA puestos a propósito).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { backendMap, derivedProps } = require('../src/core/backend');
const { F } = require('../src/core/detectors');
const { setLocale } = require('../src/core/i18n');
const { project } = require('./helpers');

const TIENDA = path.join(__dirname, '..', 'examples', 'tienda-spring');
setLocale('es');

test('Spring: cada endpoint con lo que recibe, lo que devuelve, su código y su cadena hasta la base de datos', () => {
  const m = backendMap(TIENDA, F);
  assert.equal(m.framework, 'spring');
  assert.deepEqual(m.endpoints.map((e) => e.id).sort(), [
    'DELETE /api/pedidos/{id}', 'GET /api/clientes/buscar', 'GET /api/clientes/{id}', 'GET /api/clientes/{id}', 'GET /api/pedidos', 'GET /api/pedidos/{id}', 'POST /api/clientes', 'POST /api/pedidos',
  ]);
  const crear = m.endpoints.find((e) => e.id === 'POST /api/pedidos');
  assert.deepEqual(crear.inputs.map((i) => [i.where, i.dto, i.validated]), [['body', 'CrearPedidoRequest', true]]);
  assert.equal(crear.output.cls, 'PedidoResponse');
  assert.equal(crear.output.status, 201);
  // La receta, en el orden del código.
  assert.deepEqual(crear.steps.map((s) => [s.depth, s.kind, s.cls || '', s.kind === 'external' ? s.url : s.method]), [
    [0, 'method', 'PedidoController', 'crear'],
    [1, 'method', 'PedidoService', 'crear'],
    [2, 'db', 'ClienteRepository', 'findById'],
    [2, 'method', 'ProductoClient', 'precio'],
    [3, 'external', '', 'https://api.proveedor.com/productos/{id}'],
    [2, 'db', 'PedidoRepository', 'save'],
    [2, 'method', 'PedidoMapper', 'toResponse'],
  ]);
  assert.deepEqual(crear.errors.map((x) => [x.exception, x.status, x.by]), [['RecursoNoEncontrado', 404, 'ManejadorErrores.noEncontrado']]);
  assert.match(crear.summary, /Recibe un CrearPedidoRequest en el cuerpo\. .*Llama a otra API: GET https:\/\/api\.proveedor\.com\/productos\/\{id\}\. Devuelve PedidoResponse con código 201\./);
  const borrar = m.endpoints.find((e) => e.id === 'DELETE /api/pedidos/{id}');
  assert.equal(borrar.output.status, 204);
  assert.match(borrar.summary, /Responde 204 sin contenido/);
  const obtenerCliente = m.endpoints.find((e) => e.handler === 'ClienteController.obtener');
  assert.deepEqual(obtenerCliente.errors.map((x) => [x.exception, x.status, x.handled]), [['NoSuchElementException', 500, false]], 'un .get() sin comprobar acaba en 500');
  assert.match(obtenerCliente.summary, /devuelve una entidad de la base de datos, no un DTO/);
});

test('Spring: cada pieza con su papel, los DTO con sus reglas en palabras y las APIs externas', () => {
  const m = backendMap(TIENDA);
  const role = Object.fromEntries(m.components.map((c) => [c.name, c.role]));
  assert.deepEqual(role, {
    TiendaApplication: 'app', PedidoController: 'controller', ClienteController: 'controller', PedidoService: 'service', PedidoRepository: 'repository', ClienteRepository: 'repository',
    Pedido: 'entity', Cliente: 'entity', CrearPedidoRequest: 'dto', PedidoResponse: 'dto', ClienteRequest: 'dto', ProductoDto: 'dto', DescuentoDto: 'dto',
    PedidoMapper: 'mapper', ProductoClient: 'client', RecursoNoEncontrado: 'exception', ManejadorErrores: 'handler',
  });
  const service = m.components.find((c) => c.name === 'PedidoService');
  assert.deepEqual(service.deps.sort(), ['ClienteRepository', 'PedidoMapper', 'PedidoRepository', 'ProductoClient']);
  assert.deepEqual(service.usedBy, ['PedidoController']);
  const req = m.dtos.find((d) => d.name === 'CrearPedidoRequest');
  assert.equal(req.kind, 'request');
  assert.deepEqual(req.fields.map((f) => [f.name, f.rules.join(', ')]), [['clienteId', 'obligatorio'], ['productoId', 'obligatorio'], ['cantidad', 'mínimo 1']]);
  assert.deepEqual(m.dtos.find((d) => d.name === 'PedidoResponse').createdIn, ['PedidoMapper.toResponse']);
  assert.equal(m.dtos.find((d) => d.name === 'ProductoDto').kind, 'external', 'lo que devuelve la otra API');
  assert.deepEqual(m.entities.find((e) => e.name === 'Pedido').fields.find((f) => f.name === 'cliente').relation, { kind: 'ManyToOne', target: 'Cliente' });
  assert.deepEqual(m.externals.map((x) => [x.method, x.url, x.from]), [['GET', 'https://api.proveedor.com/productos/{id}', 'ProductoClient.precio']]);
  assert.ok(m.glossary.some((g) => g.id === 'dto'));
});

test('Spring: los errores típicos de la IA en el ejemplo se encuentran, y solo esos', () => {
  const rules = backendMap(TIENDA, F).findings.map((f) => `${f.rule} ${path.basename(f.file)}:${f.line}`).sort();
  assert.deepEqual(rules, [
    'backend-duplicate-route ClienteController.java:22',
    'backend-null-response ClienteController.java:22',
    'backend-unused-dto DescuentoDto.java:3',
    'spring-derived-query ClienteRepository.java:10',
    'spring-resttemplate-timeout ProductoClient.java:12',
  ]);
});

test('Spring: las consultas derivadas aceptan operadores y propiedades anidadas', (t) => {
  assert.deepEqual(derivedProps('NombreAndEdadGreaterThanOrderByFechaDesc'), ['nombre', 'edad']);
  assert.deepEqual(derivedProps('EmailIgnoreCase'), ['email']);
  const root = project(t, {
    'pom.xml': '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>',
    'src/main/java/d/Cliente.java': '@Entity\npublic class Cliente { @Id private Long id; private String nombre; }\n',
    'src/main/java/d/Pedido.java': '@Entity\npublic class Pedido { @Id private Long id; @ManyToOne(fetch = FetchType.LAZY) private Cliente cliente; private int total; }\n',
    'src/main/java/d/PedidoRepository.java': 'public interface PedidoRepository extends JpaRepository<Pedido, Long> {\n  List<Pedido> findByClienteNombre(String n);\n  List<Pedido> findByTotalGreaterThanEqualOrderByIdDesc(int t);\n  long countByEstado(String e);\n}\n',
  });
  const found = backendMap(root, F).findings.filter((f) => f.rule === 'spring-derived-query');
  assert.deepEqual(found.map((f) => f.line), [4], 'solo «estado» no existe');
});

test('Express: rutas con prefijos, cadena controlador → servicio → base de datos, rutas duplicadas', (t) => {
  const root = project(t, {
    'package.json': '{"dependencies":{"express":"^4.19.0"}}',
    'src/app.js': "const express = require('express');\nconst pedidos = require('./routes/pedidos');\nconst app = express();\napp.use(express.json());\napp.use('/api/pedidos', pedidos);\napp.listen(3000);\n",
    'src/routes/pedidos.js': "const express = require('express');\nconst ctrl = require('../controllers/pedidosController');\nconst router = express.Router();\nrouter.get('/', ctrl.listar);\nrouter.post('/', (req, res) => ctrl.crear(req, res));\nrouter.get('/', (req, res) => res.json([]));\nmodule.exports = router;\n",
    'src/controllers/pedidosController.js': "const service = require('../services/pedidosService');\nasync function listar(req, res) {\n  res.json(await service.todos());\n}\nasync function crear(req, res) {\n  const { producto, cantidad } = req.body;\n  const p = await service.crear(producto, cantidad);\n  res.status(201).json(p);\n}\nmodule.exports = { listar, crear };\n",
    'src/services/pedidosService.js': "const db = require('../db');\nasync function todos() {\n  return db.pedido.findMany();\n}\nasync function crear(producto, cantidad) {\n  const precio = await fetch('https://api.proveedor.com/precio');\n  return db.pedido.create({ data: { producto, cantidad } });\n}\nmodule.exports = { todos, crear };\n",
    'src/db.js': 'module.exports = {};\n',
  });
  const m = backendMap(root, F);
  assert.equal(m.framework, 'express');
  const crear = m.endpoints.find((e) => e.id === 'POST /api/pedidos');
  assert.ok(crear, JSON.stringify(m.endpoints.map((e) => e.id)));
  assert.equal(crear.output.status, 201);
  assert.deepEqual(crear.inputs.find((i) => i.where === 'body').fields, ['producto', 'cantidad']);
  assert.deepEqual(crear.steps.slice(1).map((s) => `${s.kind} ${s.kind === 'external' ? s.url : s.cls + '.' + s.method}`), ['method pedidosController.crear', 'method pedidosService.crear', 'external https://api.proveedor.com/precio', 'db pedido.create']);
  const listar = m.endpoints.find((e) => e.id === 'GET /api/pedidos' && e.line === 4);
  assert.deepEqual(listar.steps.slice(1).map((s) => `${s.kind} ${s.cls}.${s.method}`), ['method pedidosController.listar', 'method pedidosService.todos', 'db pedido.findMany'], 'una función pasada sin llamar también se sigue');
  assert.deepEqual(m.findings.map((f) => f.rule), ['backend-duplicate-route']);
  assert.equal(m.findings[0].line, 6);
});

test('Express real: routers creados por una función e importados con nombre, :id en la prueba y un caché que no es la base de datos', (t) => {
  // Forma que aparece en proyectos reales (ESM, Express 5): app.use('/api', deckRoutes(opciones)).
  const root = project(t, {
    'package.json': '{"type":"module","dependencies":{"express":"^5.0.0"}}',
    'server/app.js': "import express from 'express';\nimport { deckRoutes } from './routes/decks.routes.js';\nimport { authRoutes as auth } from './routes/auth.routes.js';\nexport function createApp() {\n  const app = express();\n  app.use(express.json());\n  app.use('/api', deckRoutes({ limite: 5 }));\n  app.use('/api/auth', auth({\n    tiempo: (x) => x,\n  }));\n  return app;\n}\n",
    'server/routes/decks.routes.js': "import express from 'express';\nconst cache = new Map();\nexport function deckRoutes({ limite }) {\n  const r = express.Router();\n  r.get('/decks/:id', (req, res) => { cache.delete(req.params.id); res.json({}); });\n  r.delete('/decks/:id', (req, res) => res.status(204).end());\n  return r;\n}\n",
    'server/routes/auth.routes.js': "import { Router } from 'express';\nexport function authRoutes() {\n  const router = Router();\n  router.post('/login', (req, res) => res.json({ ok: true }));\n  return router;\n}\n",
  });
  const m = backendMap(root, F);
  assert.deepEqual(m.endpoints.map((e) => `${e.method} ${e.path}`).sort(), ['DELETE /api/decks/:id', 'GET /api/decks/:id', 'POST /api/auth/login']);
  const get = m.endpoints.find((e) => e.method === 'GET');
  assert.ok(!get.steps.some((s) => s.kind === 'db'), 'cache.delete es un Map, no la base de datos');
  assert.match(get.example.curl, /\/api\/decks\/1'/, 'el :id se rellena con un valor de ejemplo');
});

test('Express real: routers encadenados (Router().use(a).use(b)) y exportados sin nombre', (t) => {
  const root = project(t, {
    'package.json': '{"dependencies":{"express":"^4.19.0"}}',
    'src/main.ts': "import express from 'express';\nimport routes from './routes/routes';\nconst app = express();\napp.use(routes);\n",
    'src/routes/routes.ts': "import { Router } from 'express';\nimport tags from './tags';\nimport users from './users';\n\nconst api = Router()\n  .use(tags)\n  .use('/users', users);\n\nexport default Router().use('/api', api);\n",
    'src/routes/tags.ts': "import { Router } from 'express';\nconst router = Router();\nrouter.get('/tags', (req, res) => res.json([]));\nexport default router;\n",
    'src/routes/users.ts': "import { Router } from 'express';\nconst router = Router();\nrouter.post('/login', (req, res) => res.json({}));\nexport default router;\n",
  });
  assert.deepEqual(backendMap(root, F).endpoints.map((e) => `${e.method} ${e.path}`).sort(), ['GET /api/tags', 'POST /api/users/login']);
});
