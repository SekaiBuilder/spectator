'use strict';
// Mapa del backend para Django y Django REST Framework. Misma forma de resultado que el resto (ver backend.js).
// Lee urls.py (path, re_path, include y los routers de DRF), las vistas (funciones con @api_view, APIView, vistas
// genéricas y ViewSet), los serializers (los DTO de Django) y los modelos, sin ejecutar nada.
const path = require('path');
const { t } = require('./i18n');
const { indexPython, stepper, balanced, splitTop, blockAfter, roleOfFile, readText } = require('./backend-python');

const lineAt = (src, idx) => src.slice(0, idx).split('\n').length;
/** Sustituye los comentarios # por espacios (las posiciones y las líneas no cambian). */
function uncomment(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const q = src.slice(i, i + 3) === c.repeat(3) ? c.repeat(3) : c;
      let j = i + q.length;
      while (j < src.length && src.slice(j, j + q.length) !== q && (q.length === 3 || src[j] !== '\n')) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + q.length); i = j + q.length - 1; continue;
    }
    if (c === '#') { let j = i; while (j < src.length && src[j] !== '\n') j++; out += ' '.repeat(j - i); i = j - 1; continue; }
    out += c;
  }
  return out;
}
const str = (expr) => { const m = /^\s*[rbuf]*(['"])(.*)\1\s*$/s.exec(expr || ''); return m ? m[2] : null; };

// Acciones de DRF: método, si van sobre un objeto (/{pk}/), código de éxito y si leen un cuerpo.
const ACTIONS = {
  list: { method: 'GET', detail: false, status: 200, list: true },
  create: { method: 'POST', detail: false, status: 201, body: true },
  retrieve: { method: 'GET', detail: true, status: 200 },
  update: { method: 'PUT', detail: true, status: 200, body: true },
  partial_update: { method: 'PATCH', detail: true, status: 200, body: true },
  destroy: { method: 'DELETE', detail: true, status: 204 },
};
// Qué acciones trae cada clase base sin escribir código.
const GENERIC = {
  ModelViewSet: ['list', 'create', 'retrieve', 'update', 'partial_update', 'destroy'],
  ReadOnlyModelViewSet: ['list', 'retrieve'],
  ListAPIView: ['list'], CreateAPIView: ['create'], ListCreateAPIView: ['list', 'create'],
  RetrieveAPIView: ['retrieve'], UpdateAPIView: ['update', 'partial_update'], DestroyAPIView: ['destroy'],
  RetrieveUpdateAPIView: ['retrieve', 'update', 'partial_update'], RetrieveDestroyAPIView: ['retrieve', 'destroy'],
  RetrieveUpdateDestroyAPIView: ['retrieve', 'update', 'partial_update', 'destroy'],
  ListModelMixin: ['list'], CreateModelMixin: ['create'], RetrieveModelMixin: ['retrieve'], UpdateModelMixin: ['update', 'partial_update'], DestroyModelMixin: ['destroy'],
  ListView: ['list'], DetailView: ['retrieve'],
};
const HTTP = ['get', 'post', 'put', 'patch', 'delete'];

/** Ruta de Django a la forma común: <int:pk> → {pk}; (?P<pk>\d+) → {pk}. Conserva la barra final, que Django exige. */
function djangoPath(prefix, route, regex) {
  let r = route || '';
  const types = {};
  if (regex) r = r.replace(/^\^/, '').replace(/\$$/, '').replace(/\(\?P<(\w+)>([^)]*)\)/g, (all, n, re) => { types[n] = /\\d/.test(re) ? 'int' : 'str'; return '{' + n + '}'; });
  r = r.replace(/<(?:(\w+):)?(\w+)>/g, (all, conv, n) => { types[n] = conv === 'int' ? 'int' : conv || 'str'; return '{' + n + '}'; });
  return { path: ('/' + prefix + r).replace(/\/+/g, '/'), types };
}

function djangoMap(root, F, H) {
  const { mods, resolveMod } = indexPython(root);
  // Los comentarios no cuentan («# falta is_valid()» no es una llamada a is_valid).
  for (const m of mods.values()) {
    m.src = uncomment(m.src);
    for (const d of m.defs) d.body = uncomment(d.body);
    for (const c of m.classes.values()) c.body = uncomment(c.body);
  }
  const byMod = mods;
  const steps0 = stepper(mods, H, { django: true });

  // Modelos (tablas) y serializers (DTO).
  const models = new Map(), serializers = new Map();
  const isModel = (c, seen = new Set()) => c.bases.some((b) => /^(models\.Model|Model|AbstractUser|AbstractBaseUser)$/.test(b) || (!seen.has(b) && [...mods.values()].some((m) => m.classes.has(b) && isModel(m.classes.get(b), seen.add(b)))));
  for (const m of mods.values()) {
    for (const c of m.classes.values()) {
      if (isModel(c)) models.set(c.name, { ...c, file: m.rel, mod: m });
      else if (c.bases.some((b) => /Serializer$/.test(b))) serializers.set(c.name, { ...c, file: m.rel, mod: m });
    }
  }
  const modelFields = (c) => {
    const out = [];
    for (const x of c.body.matchAll(/^\s{2,}(\w+)\s*=\s*models\.(\w+)\s*\(/gm)) {
      const args = balanced(c.body, x.index + x[0].length - 1).text;
      const target = /^\s*['"]?([\w.]+)['"]?/.exec(args);
      const kind = { ForeignKey: 'ManyToOne', OneToOneField: 'OneToOne', ManyToManyField: 'ManyToMany' }[x[2]];
      out.push({ name: x[1], type: x[2], args, id: /primary_key\s*=\s*True/.test(args), relation: kind ? { kind, target: target ? target[1].split('.').pop() : '?' } : null });
    }
    if (!out.some((f) => f.id)) out.unshift({ name: 'id', type: 'AutoField', args: '', id: true, relation: null, auto: true });
    return out;
  };
  const fieldRulesOf = (type, args, { model } = {}) => {
    const rules = [];
    const optional = /required\s*=\s*False|blank\s*=\s*True|null\s*=\s*True|default\s*=|auto_now/.test(args) || /^(AutoField|BigAutoField)$/.test(type);
    if (!optional) rules.push(t`obligatorio`);
    if (/Email/.test(type)) rules.push(t`debe ser un email`);
    if (/URL/.test(type)) rules.push(t`debe ser una URL`);
    if (/^Positive/.test(type)) rules.push(t`mínimo ${0}`);
    const num = (re) => (re.exec(args) || [])[1];
    if (num(/max_length\s*=\s*(\d+)/)) rules.push(t`como mucho ${num(/max_length\s*=\s*(\d+)/)} caracteres`);
    if (num(/min_length\s*=\s*(\d+)/)) rules.push(t`al menos ${num(/min_length\s*=\s*(\d+)/)} caracteres`);
    if (num(/min_value\s*=\s*(-?[\d.]+)/)) rules.push(t`mínimo ${num(/min_value\s*=\s*(-?[\d.]+)/)}`);
    if (num(/max_value\s*=\s*(-?[\d.]+)/)) rules.push(t`máximo ${num(/max_value\s*=\s*(-?[\d.]+)/)}`);
    if (model && /unique\s*=\s*True/.test(args)) rules.push(t`no puede repetirse`);
    return rules;
  };
  const metaOf = (c) => {
    const meta = /^\s+class\s+Meta\s*:/m.exec(c.body);
    if (!meta) return { readOnly: [] };
    const body = c.body.slice(meta.index);
    const list = (name) => { const m = new RegExp(`\\b${name}\\s*=\\s*([\\[(])`).exec(body); return m ? [...balanced(body, m.index + m[0].length - 1).text.matchAll(/['"](\w+)['"]/g)].map((x) => x[1]) : null; };
    return { model: (/\bmodel\s*=\s*(\w+)/.exec(body) || [])[1] || null, all: /\bfields\s*=\s*['"]__all__['"]/.test(body), fields: list('fields'), exclude: list('exclude'), readOnly: list('read_only_fields') || [], line: c.line + lineAt(c.body, meta.index) - 1 };
  };
  const serializerFields = (c) => {
    const meta = metaOf(c);
    const out = [];
    const own = new Map();
    for (const x of c.body.matchAll(/^\s{2,}(\w+)\s*=\s*serializers\.(\w+)\s*\(/gm)) own.set(x[1], { type: x[2].replace(/Field$/, ''), args: balanced(c.body, x.index + x[0].length - 1).text });
    const model = meta.model && models.get(meta.model);
    const mf = model ? modelFields(model) : [];
    const names = meta.all ? mf.map((f) => f.name) : meta.fields || [...own.keys()];
    for (const n of names) {
      if (meta.exclude && meta.exclude.includes(n)) continue;
      const o = own.get(n), f = mf.find((x) => x.name === n);
      const readOnly = meta.readOnly.includes(n) || (o && /read_only\s*=\s*True/.test(o.args)) || (f && (f.auto || /auto_now/.test(f.args)));
      const type = o ? o.type : f ? f.type.replace(/Field$/, '') : 'str';
      out.push({ name: n, type: f && f.relation ? 'int' : type, rules: readOnly ? [t`solo lectura`] : fieldRulesOf(o ? o.type : f ? f.type : '', o ? o.args : f ? f.args : '', { model: !o }), readOnly: !!readOnly });
    }
    for (const [n, o] of own) if (!names.includes(n)) out.push({ name: n, type: o.type, rules: fieldRulesOf(o.type, o.args), readOnly: /read_only\s*=\s*True/.test(o.args) });
    return { fields: out, meta };
  };

  // Resolver un nombre de urls.py (views.clientes, ProductoViewSet, views.X.as_view()) a su función o clase.
  const lookup = (m, expr) => {
    const name = expr.replace(/\.as_view\s*\([\s\S]*$/, '').trim();
    const [a, b] = name.split('.');
    const inMod = (mm, n) => mm && (mm.defs.find((d) => d.name === n && d.indent === 0) || mm.classes.get(n));
    if (b) {
      const imp = m.imports.get(a);
      if (!imp) return { missing: false };
      const target = mods.get(imp.name && mods.has(imp.mod + '.' + imp.name) ? imp.mod + '.' + imp.name : imp.mod);
      if (!target) return { missing: false };
      const found = inMod(target, b);
      return found ? { m: target, obj: found } : { missing: true, m: target, name: b };
    }
    const local = inMod(m, a);
    if (local) return { m, obj: local };
    const imp = m.imports.get(a);
    const target = imp && imp.name && mods.get(imp.mod);
    const found = target && inMod(target, imp.name);
    return found ? { m: target, obj: found } : target ? { missing: true, m: target, name: imp.name } : { missing: false };
  };
  const methodsOf = (m, c) => {
    const inside = m.defs.filter((d) => d.line > c.line && d.line <= c.endLine && d.indent > 0);
    const base = Math.min(...inside.map((d) => d.indent));
    return new Map(inside.filter((d) => d.indent === base).map((d) => [d.name, d]));
  };
  const decorators = (m, line) => {
    const out = [];
    for (let i = line - 2; i >= 0 && /^\s*@/.test(m.lines[i]); i--) out.unshift(m.lines[i].trim());
    return out;
  };
  const classInfo = (m, c, seen = new Set()) => {
    // Las acciones heredadas de las bases (también de clases propias que heredan de ModelViewSet).
    const actions = new Set();
    for (const b of c.bases) {
      const short = b.split('.').pop();
      for (const a of GENERIC[short] || []) actions.add(a);
      const own = lookup(m, b);
      if (own.obj && own.obj.bases && !seen.has(own.obj.name)) { seen.add(own.obj.name); for (const a of classInfo(own.m, own.obj, seen).actions) actions.add(a); }
    }
    const attr = (n) => (new RegExp(`^\\s+${n}\\s*=\\s*([^\\n]+)`, 'm').exec(c.body) || [])[1];
    const qs = attr('queryset');
    return { actions, serializer: ((attr('serializer_class') || '').match(/\w+/) || [])[0] || null, queryset: qs ? qs.trim() : null, model: ((attr('model') || '').match(/\w+/) || [])[0] || null, lookup: str(attr('lookup_field')) || 'pk' };
  };

  // Recorrido de urls.py desde ROOT_URLCONF (o, si no se encuentra, desde los urls.py que nadie incluye).
  const raw = [];
  const missingViews = [];
  const routerUrls = (m) => {
    const routers = new Map();
    for (const x of m.src.matchAll(/^(\w+)\s*=\s*(?:routers\.)?(DefaultRouter|SimpleRouter|ExtendedSimpleRouter)\s*\(/gm)) routers.set(x[1], []);
    for (const x of m.src.matchAll(/^(\w+)\.register\s*\(/gm)) {
      const args = splitTop(balanced(m.src, x.index + x[0].length - 1).text);
      if (routers.has(x[1])) routers.get(x[1]).push({ prefix: str(args[0]) || '', view: args[1], line: lineAt(m.src, x.index) });
    }
    return routers;
  };
  const visited = new Set();
  const includedMods = new Set();
  const visitUrls = (m, prefix, depth) => {
    if (!m || depth > 6 || visited.has(m.mod + '|' + prefix)) return;
    visited.add(m.mod + '|' + prefix);
    const routers = routerUrls(m);
    const addRouter = (name, pre, line) => {
      for (const reg of routers.get(name) || []) {
        const v = lookup(m, reg.view);
        if (v.missing) missingViews.push({ file: m.rel, line: reg.line, name: reg.view });
        if (v.obj) raw.push({ kind: 'viewset', prefix: pre + reg.prefix + '/', m: v.m, obj: v.obj, file: m.rel, line: reg.line, viewName: reg.view });
      }
    };
    for (const x of m.src.matchAll(/^urlpatterns\s*(\+?=)\s*/gm)) {
      let at = x.index + x[0].length;
      // urlpatterns = [...] + router.urls  ·  urlpatterns += router.urls
      for (;;) {
        const rest = m.src.slice(at);
        const ru = /^\s*(\w+)\.urls\b/.exec(rest);
        if (ru) { addRouter(ru[1], prefix, lineAt(m.src, at)); at += ru[0].length; }
        else if (/^\s*\[/.test(rest)) {
          const open = at + rest.indexOf('[');
          const list = balanced(m.src, open);
          let off = open + 1;
          for (const entry of splitTop(list.text)) {
            const pos = m.src.indexOf(entry, off); off = pos + entry.length;
            const call = /^(path|re_path|url)\s*\(/.exec(entry);
            if (!call) continue;
            const args = splitTop(balanced(entry, call[0].length - 1).text);
            const route = str(args[0]) || '';
            const view = (args[1] || '').trim();
            const line = lineAt(m.src, pos);
            const full = prefix + (call[1] === 'path' ? route : route.replace(/^\^/, '').replace(/\$$/, ''));
            const inc = /^include\s*\(\s*([\s\S]*)\)$/.exec(view);
            if (inc) {
              const target = str(splitTop(inc[1])[0]);
              const ru2 = /^(\w+)\.urls$/.exec(splitTop(inc[1])[0] || '');
              if (target) { const mod = mods.get(resolveMod(m, target)) || mods.get(target); if (mod) { includedMods.add(mod.mod); visitUrls(mod, full, depth + 1); } }
              else if (ru2) addRouter(ru2[1], full, line);
              continue;
            }
            if (/^admin\.site\.urls$/.test(view)) continue;
            const v = lookup(m, view);
            if (v.missing) { missingViews.push({ file: m.rel, line, name: view.replace(/\.as_view[\s\S]*$/, '') }); continue; }
            if (!v.obj) continue;
            const actionsMap = /as_view\s*\(\s*\{([^}]*)\}/.exec(view);
            raw.push({ kind: v.obj.bases ? 'class' : 'function', path: full, regex: call[1] !== 'path', m: v.m, obj: v.obj, file: m.rel, line, viewName: view.replace(/\.as_view[\s\S]*$/, ''), actionsMap: actionsMap ? Object.fromEntries([...actionsMap[1].matchAll(/['"](\w+)['"]\s*:\s*['"](\w+)['"]/g)].map((y) => [y[1], y[2]])) : null });
          }
          at = list.end + 1;
        } else break;
        const plus = /^\s*\+\s*/.exec(m.src.slice(at));
        if (!plus) break;
        at += plus[0].length;
      }
    }
  };
  let rootConf = null;
  for (const m of mods.values()) { const x = /^ROOT_URLCONF\s*=\s*['"]([\w.]+)['"]/m.exec(m.src); if (x) { rootConf = mods.get(resolveMod(m, x[1])) || mods.get(x[1]) || [...mods.values()].find((y) => y.mod.endsWith('.' + x[1]) || y.mod === x[1]); if (rootConf) break; } }
  if (rootConf) visitUrls(rootConf, '', 0);
  else {
    const urls = [...mods.values()].filter((m) => /(^|\/)urls\.py$/.test(m.rel) && /urlpatterns/.test(m.src));
    for (const m of urls) for (const x of m.src.matchAll(/include\s*\(\s*['"]([\w.]+)['"]/g)) includedMods.add(resolveMod(m, x[1]));
    for (const m of urls) if (!includedMods.has(m.mod)) visitUrls(m, '', 0);
  }

  // Cada vista se convierte en uno o más endpoints.
  const endpoints = [];
  const blockFor = (fn, method) => {
    // El trozo de la función que atiende ese método: if request.method == "POST": …
    const lines = fn.body.split('\n');
    const ranges = [];
    lines.forEach((l, i) => {
      const x = /^(\s*)(?:if|elif)\s+request\.method\s*(?:==|in)\s*([^:]+):/.exec(l);
      if (x) { const blk = blockAfter(lines, i + 1); ranges.push({ methods: [...x[2].matchAll(/['"](\w+)['"]/g)].map((y) => y[1].toUpperCase()), from: i, to: i + blk.body.split('\n').length, body: blk.body }); }
    });
    const mine = ranges.find((r) => r.methods.includes(method));
    if (mine) return mine.body;
    return lines.filter((l, i) => !ranges.some((r) => i >= r.from && i <= r.to)).join('\n');
  };
  const bodyInputs = (body, method) => {
    const inputs = [];
    const ser = /(\w+Serializer)\s*\(\s*(?:[^()]*,\s*)?data\s*=/.exec(body);
    if (ser && method !== 'GET') inputs.push({ name: 'body', type: ser[1], where: 'body', dto: serializers.has(ser[1]) ? ser[1] : null, validated: /\.is_valid\s*\(/.test(body) });
    else if (method !== 'GET') {
      const fields = [...new Set([...body.matchAll(/(?:request\.(?:data|POST)|datos|data|payload|body)\s*(?:\[\s*['"](\w+)['"]\s*\]|\.get\(\s*['"](\w+)['"])/g)].map((x) => x[1] || x[2]))];
      if (fields.length || /request\.(data|POST|body)\b/.test(body)) inputs.push({ name: 'body', type: '{ ' + fields.join(', ') + ' }', where: 'body', fields, validated: false, raw: true });
    }
    for (const q of new Set([...body.matchAll(/request\.(?:query_params|GET)\.get\(\s*['"](\w+)['"]/g)].map((x) => x[1]))) inputs.push({ name: q, type: 'str', where: 'query' });
    return inputs;
  };
  const statusIn = (body) => {
    const x = /(?:Response|JsonResponse|HttpResponse)\s*\([^\n]*status\s*=\s*(?:status\.HTTP_)?(\d{3})/.exec(body);
    return x ? Number(x[1]) : null;
  };
  const outputOf = (body, fallbackSer, list) => {
    const ser = /(\w+Serializer)\s*\(\s*(?!data\s*=)[^)\n]*?(many\s*=\s*True)?[^)\n]*\)\.data/.exec(body) || (/serializer\.data/.test(body) && /(\w+Serializer)\s*\(/.exec(body));
    const name = ser ? ser[1] : fallbackSer;
    const many = ser ? !!ser[2] || false : list;
    if (name) return { text: many ? t`una lista de ${name}` : name, cls: name, list: many, role: serializers.has(name) ? 'dto' : null };
    if (/\brender\s*\(/.test(body)) return { text: t`una página HTML`, cls: null, list: false, role: null };
    return { text: t`un objeto JSON`, cls: null, list: false, role: null };
  };
  const errorsOf = (all, extra = []) => {
    const out = [...extra];
    const add = (exception, status, handled, by) => { if (!out.some((e) => e.exception === exception)) out.push({ exception, status, handled, by }); };
    if (/get_object_or_404\s*\(|raise\s+(Http404|NotFound)\b|self\.get_object\s*\(/.test(all)) add('Http404', 404, true, 'Django');
    if (/raise\s+(?:serializers\.)?ValidationError|is_valid\s*\(\s*raise_exception\s*=\s*True|status\s*=\s*(?:status\.HTTP_)?400/.test(all)) add('ValidationError', 400, true, 'Django REST Framework');
    if (/raise\s+PermissionDenied/.test(all)) add('PermissionDenied', 403, true, 'Django');
    if (/\.objects\.get\s*\(/.test(all) && !/DoesNotExist|ObjectDoesNotExist/.test(all)) add('DoesNotExist', 500, false, null);
    return out;
  };
  const push = (ep) => {
    ep.id = ep.method + ' ' + ep.path;
    ep.summary = H.endpointSummary({ method: ep.method, inputs: ep.inputs, out: ep.output, outRole: ep.output.role, status: ep.output.status, empty: ep.output.empty, steps: ep.steps });
    endpoints.push(ep);
  };
  const chainBody = (steps) => steps.filter((s) => s.kind === 'method' && s.depth > 0).map((s) => { const mm = [...mods.values()].find((x) => x.rel === s.file); const f = mm && mm.defs.find((d) => d.name === s.method && d.line === s.line); return f ? f.body : ''; }).join('\n');
  for (const r of raw) {
    const ctrl = (fn, name) => [{ depth: 0, kind: 'method', key: r.m.rel + '#' + name, cls: r.m.mod.split('.').pop(), method: name, ...H.roleInfo('controller'), file: r.m.rel, line: fn ? fn.line : r.obj.line }];
    if (r.kind === 'function') {
      const fn = r.obj;
      const decos = decorators(r.m, fn.line);
      const api = decos.map((d) => /^@api_view\s*\(\s*\[([^\]]*)\]/.exec(d) || /^@require_http_methods\s*\(\s*\[([^\]]*)\]/.exec(d)).find(Boolean);
      let methods = api ? [...api[1].matchAll(/['"](\w+)['"]/g)].map((x) => x[1].toUpperCase()) : null;
      if (!methods && decos.some((d) => /^@require_POST\b/.test(d))) methods = ['POST'];
      if (!methods && decos.some((d) => /^@require_(GET|safe)\b/.test(d))) methods = ['GET'];
      if (!methods) {
        const seen = [...fn.body.matchAll(/request\.method\s*==\s*['"](\w+)['"]/g)].map((x) => x[1].toUpperCase());
        methods = seen.length ? [...new Set([...seen, ...(/\breturn\b/.test(blockFor(fn, 'GET')) ? ['GET'] : [])])] : [/request\.(body|POST|data)\b/.test(fn.body) ? 'POST' : 'GET'];
      }
      const { path: full, types } = djangoPath('', r.path, r.regex);
      for (const method of methods) {
        const body = blockFor(fn, method);
        const steps = ctrl(fn, fn.name);
        steps0(r.m, { ...fn, body }, 0, steps, new Set([r.m.rel + '#' + fn.name]));
        const all = body + '\n' + chainBody(steps);
        const inputs = [...Object.keys(types).map((n) => ({ name: n, type: types[n], where: 'path' })), ...bodyInputs(body, method)];
        const status = statusIn(body) || (method === 'POST' && /status\.HTTP_201|status\s*=\s*201/.test(body) ? 201 : 200);
        const empty = status === 204;
        const out = outputOf(body, null, false);
        push({ method, path: full, handler: r.m.mod + '.' + fn.name, file: r.m.rel, line: fn.line, inputs, output: { ...out, status, empty }, steps, errors: errorsOf(all), view: { kind: 'function', decos, body, urlFile: r.file, urlLine: r.line } });
      }
      continue;
    }
    // Clases: APIView/View (métodos get/post…), genéricas y ViewSet (acciones).
    const c = r.obj;
    const info = classInfo(r.m, c);
    const own = methodsOf(r.m, c);
    const routes = [];
    if (r.kind === 'viewset') {
      const lookupName = info.lookup;
      for (const a of Object.keys(ACTIONS)) if (info.actions.has(a) || own.has(a)) routes.push({ action: a, ...ACTIONS[a], path: r.prefix + (ACTIONS[a].detail ? `{${lookupName}}/` : '') });
      for (const [name, fn] of own) {
        const deco = decorators(r.m, fn.line).find((d) => /^@action\s*\(/.test(d));
        if (!deco) continue;
        const ms = /methods\s*=\s*\[([^\]]*)\]/.exec(deco);
        const detail = /detail\s*=\s*True/.test(deco);
        const urlPath = str((/url_path\s*=\s*([^,)]+)/.exec(deco) || [])[1]) || name;
        for (const method of ms ? [...ms[1].matchAll(/['"](\w+)['"]/g)].map((x) => x[1].toUpperCase()) : ['GET']) routes.push({ action: name, method, detail, status: method === 'POST' ? 200 : 200, body: method !== 'GET', custom: true, path: r.prefix + (detail ? `{${lookupName}}/` : '') + urlPath + '/' });
      }
    } else {
      for (const h of HTTP) if (own.has(h)) routes.push({ action: h, method: h.toUpperCase(), status: 200, body: h !== 'get' && h !== 'delete', custom: true, path: r.path });
      const mapped = r.actionsMap ? Object.entries(r.actionsMap) : null;
      if (mapped) for (const [verb, a] of mapped) if (ACTIONS[a]) routes.push({ action: a, ...ACTIONS[a], method: verb.toUpperCase(), path: r.path });
      if (!mapped) for (const a of Object.keys(ACTIONS)) if (info.actions.has(a) && !routes.some((x) => x.method === ACTIONS[a].method)) routes.push({ action: a, ...ACTIONS[a], path: r.path });
    }
    for (const rt of routes) {
      const { path: full, types } = djangoPath('', rt.path, r.regex);
      for (const x of full.matchAll(/\{(\w+)\}/g)) if (!types[x[1]]) types[x[1]] = /^(pk|id)$/.test(x[1]) ? 'int' : 'str';
      const fn = own.get(rt.action) || (rt.custom ? own.get(rt.action) : null);
      const steps = ctrl(fn, c.name + '.' + rt.action);
      const qsModel = info.queryset && (/^(\w+)\.objects/.exec(info.queryset) || [])[1];
      if (!fn && (qsModel || info.model)) {
        const verb = { list: t`consulta`, create: t`guarda`, retrieve: t`busca`, update: t`actualiza`, partial_update: t`actualiza`, destroy: t`borra` }[rt.action] || t`consulta`;
        steps.push({ depth: 1, kind: 'db', key: (qsModel || info.model) + '.' + rt.action, cls: qsModel || info.model, method: { list: 'objects.all', create: 'objects.create', retrieve: 'objects.get', update: 'save', partial_update: 'save', destroy: 'delete' }[rt.action] || rt.action, verb, ...H.roleInfo('repository'), file: r.m.rel, line: c.line });
      }
      if (fn) steps0(r.m, fn, 0, steps, new Set([r.m.rel + '#' + fn.name]));
      const body = fn ? fn.body : '';
      const all = body + '\n' + chainBody(steps);
      const inputs = Object.keys(types).map((n) => ({ name: n, type: types[n] === 'str' && /^(pk|id)$/.test(n) ? 'int' : types[n], where: 'path' }));
      if (rt.body && !fn && info.serializer) inputs.push({ name: 'body', type: info.serializer, where: 'body', dto: serializers.has(info.serializer) ? info.serializer : null, validated: true });
      else if (fn) inputs.push(...bodyInputs(body, rt.method));
      const status = statusIn(body) || rt.status;
      const empty = status === 204;
      const out = fn ? outputOf(body, rt.custom ? null : info.serializer, !!rt.list) : info.serializer ? { text: rt.list ? t`una lista de ${info.serializer}` : info.serializer, cls: info.serializer, list: !!rt.list, role: serializers.has(info.serializer) ? 'dto' : null } : { text: t`un objeto JSON`, cls: null, list: false, role: null };
      const extra = !fn && ACTIONS[rt.action] && ACTIONS[rt.action].detail ? [{ exception: 'Http404', status: 404, handled: true, by: 'Django REST Framework' }] : [];
      if (!fn && rt.body) extra.push({ exception: 'ValidationError', status: 400, handled: true, by: 'Django REST Framework' });
      push({ method: rt.method, path: full, handler: r.m.mod + '.' + c.name + '.' + rt.action, file: r.m.rel, line: fn ? fn.line : c.line, inputs, output: { ...out, status, empty }, steps, errors: errorsOf(all, extra), view: { kind: r.kind, body, urlFile: r.file, urlLine: r.line } });
    }
  }

  const components = [...mods.values()].filter((m) => m.src.trim()).map((m) => {
    const hasViews = raw.some((r) => r.m === m);
    const role = hasViews ? 'controller' : /(^|\/)settings\.py$/.test(m.rel) ? 'config' : /(^|\/)manage\.py$/.test(m.rel) ? 'app' : roleOfFile(m.rel);
    return {
      id: m.rel, name: m.rel.split('/').pop(), file: m.rel, line: 1, ...H.roleInfo(role),
      deps: [...new Set([...m.imports.values()].map((i) => mods.get(i.name && mods.has(i.mod + '.' + i.name) ? i.mod + '.' + i.name : i.mod)).filter(Boolean).map((x) => x.rel))].filter((r) => r !== m.rel),
      methods: [...m.fns.keys()],
    };
  });
  const usedBy = new Map();
  for (const c of components) for (const d of c.deps) (usedBy.get(d) || usedBy.set(d, []).get(d)).push(c.id);
  for (const c of components) c.usedBy = usedBy.get(c.id) || [];

  const allSrc = [...mods.values()].map((m) => m.src).join('\n');
  const dtos = [...serializers.values()].map((c) => {
    const { fields, meta } = serializerFields(c);
    const input = endpoints.filter((e) => e.inputs.some((i) => i.dto === c.name)).map((e) => e.id);
    const output = endpoints.filter((e) => e.output.cls === c.name).map((e) => e.id);
    return { name: c.name, file: c.file, line: c.line, kind: input.length ? 'request' : output.length ? 'response' : 'dto', fields, input, output, createdIn: [], unused: (allSrc.match(new RegExp('\\b' + c.name + '\\b', 'g')) || []).length <= 1, meta };
  });
  const entities = [...models.values()].map((c) => ({
    name: c.name, file: c.file, line: c.line, table: (/db_table\s*=\s*['"](\w+)['"]/.exec(c.body) || [])[1] || null,
    fields: modelFields(c).map((f) => ({ name: f.name, type: f.type, id: f.id, relation: f.relation })),
  }));
  const externals = endpoints.flatMap((e) => e.steps.filter((s) => s.kind === 'external').map((s) => ({ method: s.method, url: s.url, from: e.id, file: s.file, line: s.line })));
  const settings = [...mods.values()].find((m) => /(^|\/)settings(\/\w+)?\.py$/.test(m.rel) && /INSTALLED_APPS|ROOT_URLCONF/.test(m.src));
  const findings = F ? djangoFindings({ endpoints, dtos, models, missingViews, settings, modelFields }, F) : [];
  for (const e of endpoints) delete e.view;
  for (const d of dtos) delete d.meta;
  void byMod; void path; void readText;
  return { framework: 'django', components, endpoints, dtos, entities, externals: [...new Map(externals.map((x) => [x.method + x.url, x])).values()], findings };
}

/** Errores típicos de Django hechos con prisa o por una IA. */
function djangoFindings({ endpoints, dtos, models, missingViews, settings, modelFields }, F) {
  const out = [];
  for (const v of missingViews) {
    out.push(F('correctness', 'django-missing-view', 'fail', v.file, v.line, v.name, {
      confidence: 95, title: t`urls.py apunta a ${v.name}, que no existe`,
      why: t`Django carga todas las rutas al arrancar: con una vista inexistente el servidor no arranca (AttributeError). Pasa cuando una IA añade la ruta pero no la vista, o le cambia el nombre.`,
      action: t`Crear la vista ${v.name} o quitar la ruta de urls.py.`, tech: t`Vista no encontrada: ${v.name}`, evidence: [`${v.file}:${v.line}`],
    }));
  }
  const byRoute = new Map();
  for (const e of endpoints) (byRoute.get(e.id) || byRoute.set(e.id, []).get(e.id)).push(e);
  for (const [id, list] of byRoute) for (const dup of list.slice(1)) {
    out.push(F('correctness', 'backend-duplicate-route', 'fail', dup.view.urlFile, dup.view.urlLine, id + '|' + dup.handler, {
      confidence: 90, title: t`${id} está definido dos veces`,
      why: t`Django usa la primera ruta que encaja (${list[0].handler}); ${dup.handler} nunca se ejecuta, aunque parezca que sí. Suele pasar cuando una IA añade una ruta sin ver que ya existía.`,
      action: t`Borrar una de las dos o cambiar su ruta.`, tech: t`Ruta duplicada`, evidence: list.map((e) => `${e.view.urlFile}:${e.view.urlLine} ${e.handler}`), related: [{ file: list[0].view.urlFile, line: list[0].view.urlLine }],
    }));
  }
  const seenFn = new Set();
  for (const e of endpoints) {
    const body = e.view.body || '';
    const key = e.file + ':' + e.line;
    // serializer.save() sin is_valid(): DRF lanza AssertionError y la API responde 500.
    const ser = /(\w+)\s*=\s*\w+Serializer\s*\(\s*(?:[^()]*,\s*)?data\s*=/.exec(body);
    if (ser && new RegExp(`\\b${ser[1]}\\.save\\s*\\(`).test(body) && !new RegExp(`\\b${ser[1]}\\.is_valid\\s*\\(`).test(body) && !seenFn.has('v' + key)) {
      seenFn.add('v' + key);
      out.push(F('correctness', 'django-save-without-valid', 'fail', e.file, e.line, e.handler, {
        confidence: 95, title: t`${e.id} guarda sin llamar antes a is_valid()`,
        why: t`Django REST Framework no deja guardar datos sin validarlos: ${ser[1]}.save() lanza un AssertionError y la API responde 500 en todas las peticiones.`,
        action: t`Añadir ${ser[1]}.is_valid(raise_exception=True) antes de ${ser[1]}.save(); así los datos incorrectos reciben un 400.`, tech: t`save() sin is_valid() en ${e.handler}`, evidence: [`${e.file}:${e.line}`],
      }));
    }
    // .objects.get() sin manejar DoesNotExist: 500 cuando no existe.
    const dne = e.errors.find((x) => x.exception === 'DoesNotExist');
    if (dne && !seenFn.has('g' + key)) {
      seenFn.add('g' + key);
      out.push(F('correctness', 'django-get-unhandled', 'risk', e.file, e.line, e.handler, {
        confidence: 88, title: t`${e.id} responde 500 si el objeto no existe`,
        why: t`.objects.get() lanza DoesNotExist cuando no encuentra nada, y nadie lo captura: el cliente recibe un 500 (error del servidor) en lugar de un 404 (no encontrado).`,
        action: t`Usar get_object_or_404(Modelo, pk=pk), o capturar Modelo.DoesNotExist y responder 404.`, tech: t`objects.get sin DoesNotExist`, evidence: [`${e.file}:${e.line}`],
      }));
    }
    if (e.view.decos && e.view.decos.some((d) => /^@csrf_exempt\b/.test(d)) && !seenFn.has('c' + key)) {
      seenFn.add('c' + key);
      out.push(F('security', 'django-csrf-exempt', 'risk', e.file, e.line, e.handler, {
        confidence: 80, title: t`${e.id} desactiva la protección CSRF`,
        why: t`Con @csrf_exempt, otra web puede enviar peticiones a este endpoint en nombre de un usuario con la sesión abierta. Las IA lo añaden para que «deje de dar error 403».`,
        action: t`Quitar @csrf_exempt. Si es un webhook de otro servicio, comprobar su firma (por ejemplo, la cabecera de Stripe).`, tech: '@csrf_exempt', evidence: [`${e.file}:${e.line}`],
      }));
    }
    const rawIn = e.inputs.find((i) => i.where === 'body' && i.raw);
    if (rawIn && /\.objects\.[\s\S]*?(create|update)\s*\(|\.save\s*\(/.test(body) && !seenFn.has('u' + key)) {
      seenFn.add('u' + key);
      out.push(F('correctness', 'backend-unvalidated-body', 'risk', e.file, e.line, e.id, {
        confidence: 85, title: t`${e.id} guarda datos del cuerpo sin validarlos`,
        why: t`Los datos llegan tal cual a la base de datos: un campo que falta da un 500 y un valor incorrecto se guarda.`,
        action: t`Leer el cuerpo con un serializer y llamar a is_valid() antes de guardar.`, tech: t`Campos leídos a mano: ${(rawIn.fields || []).join(', ') || 'request.body'}`, evidence: [`${e.file}:${e.line}`],
      }));
    }
  }
  for (const d of dtos) {
    if (d.meta && d.meta.all && d.output.length) {
      const model = d.meta.model && models.get(d.meta.model);
      const sensitive = model ? modelFields(model).map((f) => f.name).filter((n) => /pass|token|secret|hash|clave/i.test(n)) : [];
      out.push(F('security', 'django-serializer-all-fields', 'risk', d.file, d.meta.line || d.line, d.name, {
        confidence: sensitive.length ? 92 : 70, title: sensitive.length ? t`${d.name} envía ${sensitive.join(', ')} al cliente` : t`${d.name} envía todos los campos del modelo`,
        why: t`Con fields = "__all__" la respuesta incluye cada columna de la tabla, también las que se añadan más adelante. Así se filtran contraseñas o datos internos.`,
        action: t`Escribir la lista de campos que el cliente debe ver (fields = ["id", "nombre", …]).`, tech: t`fields = "__all__" en ${d.name}`, evidence: d.output.map((x) => t`Se devuelve en ${x}`),
      }));
    }
    if (d.unused) {
      out.push(F('maintainability', 'backend-unused-dto', 'risk', d.file, d.line, d.name, {
        confidence: 80, title: t`El serializer ${d.name} no se usa en ningún sitio`,
        why: t`Ningún endpoint ni función lo menciona. Suele quedar cuando una IA genera piezas «por si acaso». Confunde a quien lee el código.`,
        action: t`Borrarlo si no hace falta, o usarlo donde se pensó usar.`, tech: t`${d.name} sin referencias`, evidence: [d.file],
      }));
    }
  }
  if (settings && /^DEBUG\s*=\s*True\b/m.test(settings.src) && /^ALLOWED_HOSTS\s*=\s*\[[^\]]*['"]\*['"]/m.test(settings.src)) {
    const line = lineAt(settings.src, settings.src.search(/^DEBUG\s*=/m));
    out.push(F('security', 'django-debug-open', 'risk', settings.rel, line, 'DEBUG', {
      confidence: 75, title: t`DEBUG está activado y se aceptan peticiones de cualquier dominio`,
      why: t`Con DEBUG = True, un error muestra a cualquiera el código, la configuración y las variables. Junto con ALLOWED_HOSTS = ["*"], si esto llega a un servidor público queda todo expuesto.`,
      action: t`Leer DEBUG de una variable de entorno (falso por defecto) y poner en ALLOWED_HOSTS solo tus dominios.`, tech: 'DEBUG = True · ALLOWED_HOSTS = ["*"]', evidence: [`${settings.rel}:${line}`],
    }));
  }
  return out;
}

module.exports = { djangoMap };
