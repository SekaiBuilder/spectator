'use strict';
// Mapa del backend en FastAPI, Flask, Next.js y NestJS: mismos resultados que en Spring y Express, con los errores
// típicos de cada framework. Los ejemplos de examples/ tienen respuestas conocidas.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { backendMap } = require('../src/core/backend');
const { nextRoutePath } = require('../src/core/backend-js');
const { F } = require('../src/core/detectors');
const { setLocale } = require('../src/core/i18n');
const { project } = require('./helpers');

setLocale('es');
const EX = (name) => path.join(__dirname, '..', 'examples', name);
const rules = (m) => m.findings.map((f) => `${f.rule} ${f.file}:${f.line}`).sort();
const chain = (e) => e.steps.map((s) => `${s.depth}${s.kind === 'external' ? ' external ' + s.url : ` ${s.kind} ${s.cls}.${s.method}`}`);

test('FastAPI: prefijos de routers, modelos Pydantic, SQLAlchemy y la cadena hasta la base de datos', () => {
  const m = backendMap(EX('tienda-fastapi'), F);
  assert.equal(m.framework, 'fastapi');
  assert.deepEqual(m.endpoints.map((e) => e.id).sort(), ['GET /api/clientes/{cliente_id}', 'GET /api/pedidos', 'GET /api/pedidos/{pedido_id}', 'GET /api/pedidos/{pedido_id}', 'POST /api/pedidos', 'POST /api/pedidos/descuento']);
  const crear = m.endpoints.find((e) => e.id === 'POST /api/pedidos');
  assert.deepEqual(crear.inputs.map((i) => [i.where, i.dto]), [['body', 'PedidoCreate']]);
  assert.equal(crear.output.status, 201);
  assert.equal(crear.output.cls, 'PedidoOut');
  assert.deepEqual(chain(crear), ['0 method pedidos.crear', '1 method precios.obtener_precio', '2 external https://api.proveedor.com/precios/', '1 method crud.crear_pedido', '2 db db.add', '2 db db.commit', '2 db db.refresh']);
  assert.deepEqual(m.endpoints.find((e) => e.handler === 'app.routers.pedidos.obtener').errors.map((x) => x.status), [404]);
  // Petición de ejemplo lista para copiar, con valores que cumplen las reglas del modelo.
  assert.equal(crear.example.curl, `curl -i -X POST 'http://localhost:8000/api/pedidos' -H 'Content-Type: application/json' -d '{"cliente_id":1,"producto_id":1,"cantidad":1}'`);
  assert.equal(crear.example.expect, 201);
  assert.equal(m.endpoints.find((e) => e.handler === 'app.routers.pedidos.obtener').example.path, '/api/pedidos/1');
  assert.deepEqual(m.dtos.find((d) => d.name === 'PedidoCreate').fields.map((f) => [f.name, f.rules.join(', ')]), [['cliente_id', 'obligatorio'], ['producto_id', 'obligatorio'], ['cantidad', 'obligatorio, mayor que 0']]);
  assert.deepEqual(m.entities.find((e) => e.name === 'Pedido').fields.filter((f) => f.relation).map((f) => [f.name, f.relation.target]), [['cliente_id', 'Cliente'], ['cliente', 'Cliente']]);
  assert.deepEqual(rules(m), [
    'backend-duplicate-route app/routers/pedidos.py:31', 'backend-unused-dto app/schemas.py:15', 'python-blocking-in-async app/routers/pedidos.py:25',
    'python-entity-response app/routers/clientes.py:10', 'python-unvalidated-body app/routers/pedidos.py:36',
  ]);
});

test('Flask: blueprints con prefijo, request.json, abort y códigos en el return', (t) => {
  const root = project(t, {
    'requirements.txt': 'flask==3.0.3\n',
    'app.py': "from flask import Flask\nfrom tienda.rutas import bp\n\napp = Flask(__name__)\napp.register_blueprint(bp, url_prefix='/api')\n",
    'tienda/__init__.py': '',
    'tienda/rutas.py': "from flask import Blueprint, request, jsonify, abort\nfrom tienda import servicio\n\nbp = Blueprint('pedidos', __name__, url_prefix='/pedidos')\n\n@bp.route('/', methods=['POST'])\ndef crear():\n    datos = request.get_json()\n    nombre = request.json['nombre']\n    return jsonify(servicio.crear(nombre)), 201\n\n@bp.get('/<int:pid>')\ndef obtener(pid):\n    p = servicio.buscar(pid)\n    if p is None:\n        abort(404)\n    return jsonify(p)\n",
    'tienda/servicio.py': "def crear(nombre):\n    return {'nombre': nombre}\n\ndef buscar(pid):\n    return None\n",
  });
  const m = backendMap(root, F);
  assert.equal(m.framework, 'flask');
  const crear = m.endpoints.find((e) => e.id === 'POST /api/pedidos');
  assert.ok(crear, JSON.stringify(m.endpoints.map((e) => e.id)));
  assert.equal(crear.output.status, 201);
  assert.deepEqual(crear.inputs.find((i) => i.where === 'body').fields, ['nombre']);
  assert.deepEqual(chain(crear).slice(1), ['1 method servicio.crear']);
  const obtener = m.endpoints.find((e) => e.id === 'GET /api/pedidos/{pid}');
  assert.deepEqual(obtener.inputs.map((i) => [i.name, i.where]), [['pid', 'path']]);
  assert.deepEqual(obtener.errors.map((x) => x.status), [404]);
});

test('Next.js: rutas de app y pages, Prisma y los errores de mezclar los dos routers', () => {
  assert.equal(nextRoutePath('src/app/(tienda)/api/pedidos/[id]/route.ts'), '/api/pedidos/{id}');
  assert.equal(nextRoutePath('pages/api/archivos/[...ruta].ts'), '/api/archivos/{ruta*}');
  const m = backendMap(EX('tienda-next'), F);
  assert.equal(m.framework, 'nextjs');
  const crear = m.endpoints.find((e) => e.id === 'POST /api/pedidos');
  assert.deepEqual(crear.inputs.find((i) => i.where === 'body').fields, ['clienteId', 'productoId', 'cantidad']);
  assert.equal(crear.inputs.find((i) => i.where === 'body').validated, true, 'zod.parse cuenta como validación');
  assert.equal(crear.output.status, 201);
  assert.deepEqual(chain(crear), ['0 method pedidos.POST', '1 method pedidos.crearPedido', '2 external https://api.proveedor.com/precios/', '2 db prisma.pedido.create']);
  const uno = m.endpoints.find((e) => e.id === 'GET /api/pedidos/{id}');
  assert.deepEqual(uno.errors.map((x) => x.status), [404]);
  assert.deepEqual(m.entities.map((e) => e.name), ['Cliente', 'Pedido']);
  assert.deepEqual(rules(m), [
    'backend-duplicate-route src/app/api/clientes/route.ts:4', 'backend-unvalidated-body pages/api/clientes.ts:3', 'backend-unvalidated-body src/app/api/clientes/route.ts:4',
    'next-lowercase-handler src/app/api/pedidos/[id]/route.ts:10', 'next-private-env-client src/components/Carrito.tsx:4', 'next-req-body-app-router src/app/api/clientes/route.ts:4',
  ]);
});

test('NestJS: controladores, servicios inyectados, DTO con class-validator y entidades TypeORM', () => {
  const m = backendMap(EX('tienda-nest'), F);
  assert.equal(m.framework, 'nestjs');
  const crear = m.endpoints.find((e) => e.id === 'POST /pedidos');
  assert.deepEqual(crear.inputs.map((i) => [i.where, i.dto]), [['body', 'CrearPedidoDto']]);
  assert.equal(crear.output.status, 201);
  assert.deepEqual(chain(crear), ['0 method PedidosController.crear', '1 method PedidosService.crear', '2 db pedidosRepository.save']);
  const uno = m.endpoints.find((e) => e.handler === 'PedidosController.obtener');
  assert.deepEqual(uno.inputs.map((i) => [i.name, i.where]), [['id', 'path']]);
  assert.deepEqual(uno.errors.map((x) => [x.exception, x.status]), [['NotFoundException', 404]]);
  assert.deepEqual(m.dtos.find((d) => d.name === 'CrearPedidoDto').fields.map((f) => f.name), ['clienteId', 'productoId', 'cantidad']);
  assert.deepEqual(rules(m), [
    'backend-duplicate-route src/pedidos/pedidos.controller.ts:26', 'backend-entity-response src/pedidos/pedidos.controller.ts:16',
    'backend-unused-dto src/pedidos/dto/cupon.dto.ts:3', 'nest-missing-validation-pipe src/main.ts:1',
  ]);
});

test('Django: urls con include y router, vistas de función, genéricas y ViewSet, serializers y modelos', () => {
  const m = backendMap(EX('tienda-django'), F);
  assert.equal(m.framework, 'django');
  assert.equal(m.baseUrl, 'http://localhost:8000');
  const ids = m.endpoints.map((e) => e.id);
  for (const id of ['GET /api/clientes/', 'POST /api/clientes/', 'GET /api/clientes/{pk}/', 'POST /api/pedidos/', 'DELETE /api/pedidos/{pk}/', 'GET /api/pedidos/lista/', 'POST /api/pagos/webhook/',
    'GET /api/productos/', 'POST /api/productos/', 'GET /api/productos/{pk}/', 'PUT /api/productos/{pk}/', 'PATCH /api/productos/{pk}/', 'DELETE /api/productos/{pk}/', 'GET /api/productos/{pk}/precio/']) assert.ok(ids.includes(id), id);
  assert.equal(ids.length, 14, 'admin/ no es un endpoint de la API');
  const by = (id) => m.endpoints.find((e) => e.id === id);
  // Cada método de una vista con if request.method == "POST" tiene su propio código y sus propias entradas.
  assert.equal(by('POST /api/clientes/').output.status, 201);
  assert.deepEqual(by('GET /api/clientes/').inputs.map((i) => i.where + ':' + i.name), ['query:buscar']);
  assert.equal(by('DELETE /api/productos/{pk}/').output.status, 204);
  assert.equal(by('POST /api/productos/').inputs.find((i) => i.where === 'body').dto, 'ProductoSerializer');
  assert.deepEqual(chain(by('GET /api/productos/{pk}/precio/')), ['0 method views.ProductoViewSet.precio', '1 method services.precio_proveedor', '2 external https://api.proveedor.com/precio']);
  assert.ok(by('GET /api/clientes/{pk}/').errors.some((e) => e.status === 500 && !e.handled));
  assert.ok(by('DELETE /api/pedidos/{pk}/').errors.some((e) => e.status === 404 && e.handled));
  // Prueba de ejemplo: barra final (Django la exige), {pk} con un número y sin los campos de solo lectura.
  assert.equal(by('POST /api/pedidos/').example.curl, `curl -i -X POST 'http://localhost:8000/api/pedidos/' -H 'Content-Type: application/json' -d '{"cliente":1,"producto":1,"cantidad":1}'`);
  const pedido = m.dtos.find((d) => d.name === 'PedidoSerializer');
  assert.deepEqual(pedido.fields.find((f) => f.name === 'cantidad').rules, ['obligatorio', 'mínimo 1', 'máximo 50']);
  assert.deepEqual(pedido.fields.find((f) => f.name === 'id').rules, ['solo lectura']);
  assert.deepEqual(m.entities.find((e) => e.name === 'Pedido').fields.filter((f) => f.relation).map((f) => f.relation.target), ['Cliente', 'Producto']);
  // Los errores sembrados (el webhook tiene dos), y solo esos.
  assert.deepEqual(rules(m), [
    'backend-unused-dto tienda/serializers.py:30',
    'backend-unvalidated-body tienda/views.py:65',
    'django-csrf-exempt tienda/views.py:65',
    'django-debug-open config/settings.py:6',
    'django-get-unhandled tienda/views.py:38',
    'django-missing-view tienda/urls.py:17',
    'django-save-without-valid tienda/views.py:45',
    'django-serializer-all-fields tienda/serializers.py:6',
  ]);
});

test('Django: re_path, include de otra app y vistas de clase con get/post', (t) => {
  const root = project(t, {
    'manage.py': 'import django\n',
    'web/settings.py': "ROOT_URLCONF = 'web.urls'\nINSTALLED_APPS = []\n",
    'web/urls.py': "from django.urls import include, path\n\nurlpatterns = [\n    path('v1/', include('notas.urls')),\n]\n",
    'notas/models.py': 'from django.db import models\n\n\nclass Nota(models.Model):\n    texto = models.TextField()\n',
    'notas/views.py': "from django.http import JsonResponse\nfrom django.views import View\nfrom .models import Nota\n\n\nclass NotaView(View):\n    def get(self, request, nota_id):\n        nota = Nota.objects.filter(id=nota_id).first()\n        return JsonResponse({'texto': nota.texto})\n\n    def post(self, request, nota_id):\n        return JsonResponse({'ok': True}, status=201)\n",
    'notas/urls.py': "from django.urls import re_path\nfrom .views import NotaView\n\nurlpatterns = [\n    re_path(r'^notas/(?P<nota_id>\\d+)/$', NotaView.as_view()),\n]\n",
  });
  const m = backendMap(root, F);
  assert.equal(m.framework, 'django');
  assert.deepEqual(m.endpoints.map((e) => e.id), ['GET /v1/notas/{nota_id}/', 'POST /v1/notas/{nota_id}/']);
  assert.equal(m.endpoints[1].output.status, 201);
  assert.deepEqual(m.endpoints[0].inputs, [{ name: 'nota_id', type: 'int', where: 'path' }]);
  assert.match(m.endpoints[0].example.curl, /\/v1\/notas\/1\/'$/);
});
