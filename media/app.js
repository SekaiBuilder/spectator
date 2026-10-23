/* Interfaz de Spectator. La misma página sirve dentro de VS Code (webview) y como informe HTML autónomo. */
(function () {
  'use strict';
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  const post = (msg) => vscode && vscode.postMessage(msg);
  // Un fallo al pintar el panel se comunica a la extensión: así se detecta también fuera de las pruebas.
  window.addEventListener('error', (e) => post({ type: 'clientError', message: String((e && e.message) || e) }));
  const saved = (vscode && vscode.getState()) || {};
  const S = {
    data: window.__PG_DATA__ || null, tab: saved.tab === 'decisiones' ? 'problemas' : saved.tab || 'resumen', mode: window.__PG_MODE__ === 'pro' ? 'eng' : window.__PG_MODE__ === 'simple' ? 'simple' : saved.mode || 'simple', onlyNew: false,
    sev: null, cat: '', q: '', open: null, shown: 150, stmFilter: null, busy: false,
    scope: saved.scope || '',
    // Actividad en vivo: la envía la extensión (cambios de archivos, llamadas a la API, errores de log).
    act: { events: [], api: null, logs: [], guess: null, filter: 'all', open: null, assets: false },
    // Última subvista de cada grupo, y estado de la cronología y del mapa del backend.
    lastSub: Object.assign({ actividad: 'cronologia', mapa: 'backend' }, saved.lastSub || {}),
    chrono: { data: null, who: '', by: 'time', open: null },
    be: { open: null, section: null },
    // Modo en vivo: la aplicación arrancada por Spectator (estado, puertos, endpoints, peticiones de sondeo).
    live: null,
    flow: { level: null, focus: null, sel: null, problems: false, live: false, totals: null, output: '', command: saved.command || 'npm start' },
  };
  // Idioma: el diccionario llega incrustado por la extensión o el informe (vacío = español).
  const L10N = window.__PG_L10N__ || {};
  const LOC = window.__PG_LOCALE__ || 'es';
  const tr = (key) => L10N[key] || key;
  function T(strings, ...vals) {
    const tpl = tr(strings.reduce((a, s, i) => a + '{' + (i - 1) + '}' + s));
    return vals.length ? tpl.replace(/\{(\d+)\}/g, (m, i) => String(vals[i])) : tpl;
  }
  document.documentElement.lang = LOC;
  const persist = () => vscode && vscode.setState({ tab: S.tab, mode: S.mode, command: S.flow.command, scope: S.scope, lastSub: S.lastSub });
  const root = document.getElementById('app');

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const SEV = { fail: T`Falla`, risk: T`Riesgo`, human: T`Tu decisión` };
  const SEVS = { fail: T`fallas`, risk: T`riesgos`, human: T`decisiones` };
  const SEV1 = { fail: T`falla`, risk: T`riesgo`, human: T`decisión` };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const base = (p) => p.split('/').pop();
  const openFile = (file, line) => post({ type: 'open', file, line });
  // ───────────────────────── Partes del proyecto
  // El alcance (S.scope) es una carpeta: '' = el proyecto entero. Todas las pestañas muestran solo lo que hay dentro.
  const inScope = (rel) => !S.scope || rel === S.scope || rel.startsWith(S.scope + '/');
  const findings = () => (S.data ? S.data.findings.filter((f) => (!S.onlyNew || f.isNew) && (!S.scope || (f.scope !== 'project' && inScope(f.file)))) : []);
  const statements = () => S.data.statements.filter((s) => inScope(s.file));
  const SEV_RANK = { fail: 0, human: 1, risk: 2 };
  const worse = (a, b) => (a && (!b || SEV_RANK[a] < SEV_RANK[b]) ? a : b);
  let _model = null;
  function model() {
    if (_model && _model.data === S.data && _model.onlyNew === S.onlyNew) return _model;
    const g = S.data.graph;
    const dirs = new Map();
    const ensure = (d) => dirs.get(d) || dirs.set(d, { files: [], dirs: [] }).get(d);
    ensure('');
    g.files.forEach((f, i) => {
      const parts = f.rel.split('/');
      let d = '';
      for (let k = 0; k < parts.length - 1; k++) {
        const next = d ? d + '/' + parts[k] : parts[k];
        if (!dirs.has(next)) { ensure(d).dirs.push(next); ensure(next); }
        d = next;
      }
      ensure(d).files.push(i);
    });
    const unitsOf = new Map();
    g.units.forEach((u, i) => (unitsOf.get(u.f) || unitsOf.set(u.f, []).get(u.f)).push(i));
    const fileIdx = new Map(g.files.map((f, i) => [f.rel, i]));
    // Cada aviso se asigna a la función que lo contiene: por nombre si lo trae, si no por rango de líneas.
    const byFile = new Map(), byUnit = new Map(), fileSev = new Map(), unitSev = new Map();
    for (const f of S.data.findings) {
      if ((S.onlyNew && !f.isNew) || f.scope === 'project') continue;
      (byFile.get(f.file) || byFile.set(f.file, []).get(f.file)).push(f);
      fileSev.set(f.file, worse(f.severity, fileSev.get(f.file)));
      const fi = fileIdx.get(f.file);
      if (fi == null) continue;
      let best = -1;
      for (const i of unitsOf.get(fi) || []) {
        const u = g.units[i];
        if (f.symbol && u.name === f.symbol) { best = i; break; }
        if (u.end != null && f.line >= u.line && f.line <= u.end && (best < 0 || u.end - u.line < g.units[best].end - g.units[best].line)) best = i;
      }
      if (best < 0) continue;
      (byUnit.get(best) || byUnit.set(best, []).get(best)).push(f);
      unitSev.set(best, worse(f.severity, unitSev.get(best)));
    }
    const comp = new Map((S.data.components || []).map((c) => [c.path, c]));
    _model = { data: S.data, onlyNew: S.onlyNew, dirs, unitsOf, fileIdx, byFile, byUnit, fileSev, unitSev, comp, stats: new Map(), unitIndex: new Map(g.units.map((u, i) => [u.id, i])) };
    if (!dirs.has(S.scope)) S.scope = '';
    return _model;
  }
  /** Una cadena de carpetas con un solo hijo (src/main/java/…) se recorre de un salto. */
  function collapse(dir) {
    const M = model();
    // Un componente nunca se salta: es una parte con identidad propia aunque solo contenga una carpeta.
    for (let n = M.dirs.get(dir); n && n.dirs.length === 1 && !n.files.length && !M.comp.has(dir); n = M.dirs.get(dir)) dir = n.dirs[0];
    return dir;
  }
  function statsFor(dir) {
    const M = model(), g = S.data.graph;
    if (M.stats.has(dir)) return M.stats.get(dir);
    const st = { files: 0, units: 0, fail: 0, risk: 0, human: 0, sev: null };
    g.files.forEach((f, i) => {
      if (dir && f.rel !== dir && !f.rel.startsWith(dir + '/')) return;
      st.files++; st.units += (M.unitsOf.get(i) || []).length;
      for (const x of M.byFile.get(f.rel) || []) st[x.severity]++;
    });
    st.sev = st.fail ? 'fail' : st.human ? 'human' : st.risk ? 'risk' : null;
    M.stats.set(dir, st);
    return st;
  }
  /** Hijos directos de una carpeta: subcarpetas (ya colapsadas) y archivos sueltos. */
  function children(dir) {
    const M = model(), node = M.dirs.get(dir) || { dirs: [], files: [] };
    const rel = (p) => (dir ? p.slice(dir.length + 1) : p);
    return {
      dirs: node.dirs.map(collapse).map((p) => ({ path: p, label: rel(p), comp: M.comp.get(p) || null, st: statsFor(p) })),
      files: node.files,
    };
  }
  /** Una parte se llama como su carpeta, salvo que tenga nombre propio (declarado o en su package.json). */
  const partName = (k) => (k.comp && (k.comp.declared || k.comp.name !== base(k.comp.path)) ? k.comp.name : k.label);
  const scopeName = () => (S.scope ? (model().comp.get(S.scope) || {}).name || base(S.scope) : S.data.name);
  function setScope(dir, patch) {
    S.scope = dir ? collapse(dir) : '';
    Object.assign(S.flow, { level: null, focus: null, sel: null });
    Object.assign(S, { open: null, shown: 150 }, patch || {});
    persist(); render();
  }
  /** Agrupa avisos como los vería quien busca dónde se rompe o se atasca el programa. */
  function grouped(list) {
    return [[T`Roto`, list.filter((f) => f.severity === 'fail')], [T`Fluye mal`, list.filter((f) => f.severity !== 'fail' && f.flow)], [T`Otros avisos`, list.filter((f) => f.severity !== 'fail' && !f.flow)]].filter((x) => x[1].length);
  }

  // ───────────────────────── Estado global
  // Lo que limita el análisis vale en todas las pestañas y con cualquier parte elegida: filtrar no lo oculta.
  function globalNotes() {
    const d = S.data, st = d.stats || {}, notes = [];
    const detail = (f) => () => set({ scope: '', tab: 'problemas', sev: null, cat: '', q: '', onlyNew: false, open: f.id });
    const incomplete = d.findings.find((f) => f.rule === 'incomplete-analysis');
    if (st.complete === false) notes.push({ text: T`El análisis del proyecto está incompleto: ${(st.skipped || []).length} archivos o carpetas sin analizar. No encontrar avisos no garantiza que todo esté correcto.`, go: incomplete && detail(incomplete) });
    for (const t of st.deep ? st.tools || [] : []) if (t.name !== 'tree-sitter' && (!t.ok || t.partial)) notes.push({ text: `${t.name}: ${t.partial ? T`parcial (${t.detail})` : T`no ejecutado (${t.detail})`}` });
    const host = d.host || {};
    if ((host.unanalyzedRoots || []).length) notes.push({ text: T`Solo se analiza «${host.root}»` + ' · ' + T`sin analizar: ${host.unanalyzedRoots.join(', ')}` });
    const project = S.scope ? d.findings.filter((f) => f.scope === 'project' && f.rule !== 'incomplete-analysis') : [];
    if (project.length) notes.push({ text: T`Avisos de todo el proyecto que no se cuentan en esta parte: ${project.length}.`, go: () => setScope('', { tab: 'problemas', sev: null, cat: '', q: '' }) });
    return notes;
  }

  // ───────────────────────── Estructura general
  function render() {
    stopFlow();
    root.textContent = '';
    if (!S.data) {
      root.append(h('div', { class: 'empty' }, h('b', {}, T`Analizando el proyecto…`), T`La primera vez puede tardar unos segundos.`));
      return;
    }
    const d = S.data, M = model();
    // Las decisiones viven dentro de Problemas: una pestaña menos que entender.
    if (S.tab === 'decisiones') S.tab = 'problemas';
    const all = findings();
    const ruleIssues = statements().filter((s) => s.status === 'conflict' || s.status === 'inconsistent').length;
    const liveErrors = S.act.events.filter(isError).length;
    // Cinco destinos; Actividad y Mapa tienen subvistas. Así la barra no se llena de pestañas.
    const group = groupOf(S.tab);
    if (GROUPS[group]) S.lastSub[group] = S.tab;
    const tabs = [['resumen', T`Resumen`], ['actividad', T`Actividad`, liveErrors + (S.live ? S.live.findings.length : 0)], ['problemas', T`Problemas`, all.length], ['mapa', T`Mapa`], ['statements', T`Reglas`, ruleIssues]];
    const comps = [...M.comp.values()];
    const options = [h('option', { value: '', selected: !S.scope }, T`Proyecto entero`)];
    for (const c of comps) options.push(h('option', { value: c.path, selected: S.scope === collapse(c.path) }, '\u00a0\u00a0'.repeat(c.path.split('/').length - 1) + c.name + (c.kind ? ' · ' + c.kind : '')));
    if (S.scope && !comps.some((c) => collapse(c.path) === S.scope)) options.push(h('option', { value: S.scope, selected: true }, S.scope));
    const crumbs = [];
    if (S.scope || (S.tab === 'flow' && S.flow.focus != null)) {
      crumbs.push(h('button', { class: 'link', onclick: () => setScope('') }, d.name));
      let acc = '';
      for (const part of S.scope ? S.scope.split('/') : []) {
        acc = acc ? acc + '/' + part : part;
        const here = acc;
        crumbs.push(h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'), h('button', { class: 'link', 'aria-current': here === S.scope && S.flow.focus == null ? 'true' : null, onclick: () => setScope(here) }, part));
      }
      if (S.tab === 'flow' && S.flow.focus != null && d.graph.files[S.flow.focus]) crumbs.push(h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'), h('b', {}, base(d.graph.files[S.flow.focus].rel)));
    }
    root.append(
      h('header', { class: 'top' + (S.busy ? ' busy' : '') },
        h('div', { class: 'brand' }, shield(), 'Spectator'),
        // Varias carpetas en el área de trabajo: se elige cuál ver; cada una tiene su propio análisis.
        (d.host && d.host.roots && d.host.roots.length > 1) ? h('select', { class: 'scope', 'aria-label': T`Carpeta del área de trabajo`, title: T`Cada carpeta tiene su propio análisis`, onchange: (e) => post({ type: 'selectRoot', path: e.target.value }) },
          d.host.roots.map((r) => h('option', { value: r.path, selected: r.current }, r.name))) : null,
        // El selector de partes solo aparece cuando el proyecto tiene partes que elegir.
        options.length > 1 ? h('select', { class: 'scope', 'aria-label': T`Qué parte del proyecto ver`, title: T`Ver el proyecto entero o solo una de sus partes`, onchange: (e) => setScope(e.target.value) }, options) : null,
        h('div', { class: 'spacer' }),
        // Dos formas de ver lo mismo: lo esencial con su siguiente paso, o todos los datos técnicos a la vista.
        h('div', { class: 'seg mode', role: 'group', 'aria-label': T`Vista` },
          h('button', { 'aria-pressed': String(S.mode !== 'eng'), title: T`Lo esencial y el siguiente paso, en lenguaje sencillo`, onclick: () => setMode('simple') }, T`Sencillo`),
          h('button', { 'aria-pressed': String(S.mode === 'eng'), title: T`Reglas internas, rutas completas, certeza, filtros y fragmentos de código`, onclick: () => setMode('eng') }, T`Profesional`)),
        h('button', { class: 'btn primary host-only', onclick: () => post({ type: 'scan' }) }, S.busy ? T`Analizando…` : T`Analizar de nuevo`)),
      h('nav', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label, n]) =>
        h('button', { role: 'tab', 'aria-selected': String(group === id), onclick: () => set({ tab: GROUPS[id] ? S.lastSub[id] : id, open: null }) }, label, n ? h('span', { class: 'count' }, n) : null))));
    if (GROUPS[group]) root.append(h('nav', { class: 'subtabs', 'aria-label': T`Secciones` }, GROUPS[group].map((id) =>
      h('button', { 'aria-pressed': String(S.tab === id), onclick: () => set({ tab: id, open: null }) }, SUBLABEL[id](), id === 'vivo' && S.live && S.live.findings.length ? h('span', { class: 'count' }, S.live.findings.length) : null))));
    if (crumbs.length) root.append(h('nav', { class: 'crumbs', 'aria-label': T`Dónde estás` }, crumbs));
    const notes = globalNotes();
    if (notes.length) root.append(h('div', { class: 'notice', role: 'status', 'aria-label': T`Estado global del análisis` },
      notes.map((n) => h('div', {}, h('span', { 'aria-hidden': 'true' }, '! '), n.text, n.go ? ' ' : null, n.go ? h('button', { class: 'link', onclick: n.go }, T`Ver detalle`) : null))));
    const view = h('main', { class: 'view' });
    root.append(view);
    ({ resumen: viewResumen, cronologia: viewCronologia, actividad: viewActividad, vivo: viewVivo, problemas: viewProblemas, backend: viewBackend, flow: viewFlow, statements: viewStatements })[S.tab](view);
  }
  const GROUPS = { actividad: ['cronologia', 'actividad', 'vivo'], mapa: ['backend', 'flow'] };
  const SUBLABEL = { cronologia: () => T`Cronología`, actividad: () => T`API y logs`, vivo: () => T`App en marcha`, backend: () => T`Backend`, flow: () => T`Código` };
  const groupOf = (tab) => (GROUPS.actividad.includes(tab) ? 'actividad' : GROUPS.mapa.includes(tab) ? 'mapa' : tab);
  function set(patch) { Object.assign(S, patch); persist(); render(); }
  /** El modo se guarda también en los ajustes de VS Code: la próxima vez se abre igual. */
  function setMode(mode) { set({ mode }); post({ type: 'mode', mode: mode === 'eng' ? 'pro' : 'simple' }); }
  function shield() {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '18'); s.setAttribute('height', '18'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.500-8-9V6z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M8.500 12l2.500 2.500 4.500-5"/>';
    return s;
  }

  // ───────────────────────── Resumen
  // Una respuesta, un siguiente paso y las partes del proyecto. Lo demás queda plegado.
  function counts(list) { return { fail: list.filter((f) => f.severity === 'fail').length, risk: list.filter((f) => f.severity === 'risk').length, human: list.filter((f) => f.severity === 'human').length }; }
  /** Lo más útil que se puede hacer ahora, en una frase y un botón. */
  function nextStep(list) {
    const problems = (patch) => () => set({ tab: 'problemas', sev: null, cat: '', q: '', open: null, ...patch });
    const first = (sev) => list.find((f) => f.severity === sev);
    const c = counts(list), rules = statements();
    const conflict = rules.filter((s) => s.status === 'conflict').length;
    // Lo que acaba de fallar en tu aplicación va antes que cualquier aviso del código.
    const live = recentFailure();
    if (live) return { text: failureTitle(live), why: live.type === 'api' ? live.explanation.title + (live.frames && live.frames[0] ? '. ' + T`Empieza en ${base(live.frames[0].file)}, línea ${live.frames[0].line}.` : '.') : live.cause || T`Error en el log de tu aplicación.`, label: T`Ver qué pasó`, go: () => set({ tab: 'actividad', act: { ...S.act, open: live.id } }) };
    if (c.fail) return { text: first('fail').title, why: c.fail > 1 ? T`Es el primero de ${c.fail} fallos demostrados.` : T`Es el único fallo demostrado.`, label: T`Ver el problema`, go: problems({ open: first('fail').id }) };
    if (c.human) return { text: c.human === 1 ? T`Hay 1 decisión que solo tú puedes tomar.` : T`Hay ${c.human} decisiones que solo tú puedes tomar.`, why: first('human').title, label: T`Decidir`, go: problems({ open: first('human').id }) };
    if (conflict) return { text: T`Un valor del código ya no cumple una regla que confirmaste.`, why: T`Cámbialo en el código o acepta el valor nuevo como regla.`, label: T`Ver reglas`, go: () => set({ tab: 'statements', stmFilter: 'conflict' }) };
    if (c.risk) return { text: c.risk === 1 ? T`Revisa 1 riesgo.` : T`Revisa ${c.risk} riesgos.`, why: T`No son errores seguros: decide si te afectan.`, label: T`Ver riesgos`, go: problems({ sev: 'risk' }) };
    if (rules.some((s) => s.status === 'unconfirmed')) return { text: T`Confirma las reglas de tu proyecto.`, why: T`Así te avisaré si alguien cambia un límite o un valor importante.`, label: T`Ver reglas`, go: () => set({ tab: 'statements', stmFilter: 'unconfirmed' }) };
    return { text: T`No hay nada urgente.`, why: T`Vuelve a analizar después de tus próximos cambios.`, label: null };
  }
  const REASON = {
    incomplete: T`el análisis está incompleto`, legacy: T`el punto de partida es de una versión anterior`, engine: T`cambió la versión de Spectator`,
    exclude: T`cambiaron los archivos excluidos`, limits: T`cambiaron los límites de spectator.json`, rules: T`cambiaron las reglas confirmadas`,
    architecture: T`cambiaron las reglas de arquitectura`, checks: T`cambió el tipo de análisis (normal o profundo)`, future: T`el punto de partida es de una versión más nueva de Spectator`,
  };
  function viewResumen(view) {
    const d = S.data, st = d.stats, mine = findings();
    const c = S.scope ? counts(mine) : d.counts;
    const verdict = S.scope ? (c.fail ? 'fail' : c.human ? 'human' : c.risk ? 'risk' : 'pass') : d.verdict;
    const headline = S.scope ? (c.fail ? T`«${scopeName()}» tiene ${plural(c.fail, T`falla demostrada`, T`fallas demostradas`)}` : c.human + c.risk ? T`«${scopeName()}» no tiene fallas demostradas` : T`«${scopeName()}»: sin problemas detectados en lo analizado`)
      : st.complete === false ? T`El análisis está incompleto` : c.fail ? T`Tu proyecto tiene ${plural(c.fail, T`falla demostrada`, T`fallas demostradas`)}`
      : c.human ? T`Sin fallas. Hay ${plural(c.human, T`decisión que solo tú puedes tomar`, T`decisiones que solo tú puedes tomar`)}`
        : c.risk ? T`Sin fallas demostradas, con ${plural(c.risk, T`riesgo`, T`riesgos`)} a revisar` : T`Sin problemas detectados en lo analizado`;
    // Una frase que explica qué significa el resultado, sin leyenda de colores.
    const meaning = c.fail ? T`Un fallo demostrado es código que, tal como está escrito, no puede funcionar bien.`
      : c.human ? T`Son preguntas sobre lo que quieres que haga tu proyecto: nadie más puede responderlas.`
        : c.risk ? T`Un riesgo no es un error seguro: revisa si te afecta.`
          : T`No garantiza que todo funcione: solo que no encontré problemas en lo que pude analizar.`;
    const p = h('div', { class: 'pad' });
    p.append(h('div', { class: 'hero' },
      h('div', { class: 'ring ' + verdict, 'aria-hidden': 'true' }, verdict === 'pass' ? '✓' : verdict === 'human' ? '?' : '!'),
      h('div', {}, h('h1', {}, headline), h('p', {}, meaning))));

    const next = nextStep(mine);
    const more = mine.length > 1 ? h('button', { class: 'btn', onclick: () => set({ tab: 'problemas', sev: null, cat: '', q: '', open: null }) }, T`Ver todos los problemas (${mine.length})`) : null;
    p.append(h('section', { class: 'next', 'aria-label': T`Tu siguiente paso` },
      h('div', { class: 'next-label' }, T`Tu siguiente paso`),
      h('div', { class: 'next-text' }, next.text),
      next.why ? h('div', { class: 'muted' }, next.why) : null,
      h('div', { class: 'actions' }, next.label ? h('button', { class: 'btn primary', onclick: next.go }, next.label) : h('button', { class: 'btn primary host-only', onclick: () => post({ type: 'scan' }) }, T`Analizar de nuevo`), more)));

    const changing = (d.changes && d.changes.files) || [];
    if (!S.scope && (changing.length || S.act.api)) {
      p.append(h('p', { class: 'now' },
        changing.length ? (changing.length === 1 ? T`Estás cambiando 1 archivo.` : T`Estás cambiando ${changing.length} archivos.`) : null,
        S.act.api ? ' ' + T`Vigilando tu API.` : null, ' ',
        h('button', { class: 'link', onclick: () => set({ tab: 'actividad' }) }, T`Ver actividad`)));
    }
    if (!S.scope && (d.backend || (S.chrono.data && S.chrono.data.total))) {
      const ai = S.chrono.data ? S.chrono.data.agents.filter((a) => a.who) : [];
      p.append(h('p', { class: 'now' },
        d.backend ? [T`Tu backend tiene ${plural(d.backend.endpoints.length, T`endpoint`, T`endpoints`)}.`, ' ', h('button', { class: 'link', onclick: () => set({ tab: 'backend' }) }, T`Ver el mapa del backend`), ' '] : null,
        ai.length ? [T`Hoy ${ai.map((a) => T`${a.who} cambió ${plural(a.files, T`archivo`, T`archivos`)}`).join(', ')}.`, ' ', h('button', { class: 'link', onclick: () => set({ tab: 'cronologia' }) }, T`Ver la cronología`)] : null));
    }
    if (!S.scope && d.delta) {
      const since = new Date(d.delta.baselineAt).toLocaleDateString(LOC, { day: 'numeric', month: 'long' });
      p.append(h('p', { class: 'delta-line muted' }, T`Desde el ${since}: `, h('b', { class: d.delta.added ? 'up' : '' }, T`${d.delta.added} nuevos`), ' · ', h('b', { class: d.delta.fixed ? 'down' : '' }, T`${d.delta.fixed} resueltos`),
        d.delta.added || S.onlyNew ? [' ', h('button', { class: 'chip', 'aria-pressed': String(S.onlyNew), onclick: () => set({ onlyNew: !S.onlyNew }) }, T`Ver solo lo nuevo`)] : null,
        S.mode === 'eng' || d.delta.comparison === 'incomparable' ? [' ', h('button', { class: 'btn small host-only', title: T`A partir de ahora, «nuevo» significará «posterior a este momento»`, onclick: () => post({ type: 'setBaseline' }) }, T`Marcar punto de partida`)] : null));
      // Un aviso que desaparece por cambiar la configuración o el tipo de análisis no es un arreglo: se dice por qué no cuenta.
      const why = (d.delta.reasons || []).map((r) => REASON[r]).filter(Boolean).join(', ');
      if (d.delta.comparison === 'incomparable') p.append(h('p', { class: 'stale' }, T`Los resueltos no se pueden contar: ${why}.`));
      else if (d.delta.comparison === 'partial') p.append(h('p', { class: 'stale' }, T`Algunos avisos no cuentan como resueltos: ${why}.`));
    }

    // El proyecto como organismo: sus partes, cada una con su estado. Un clic entra en ella.
    const kids = children(S.scope).dirs.filter((k) => k.st.files);
    if (kids.length) {
      p.append(h('h2', {}, S.scope ? T`Dentro de «${scopeName()}»` : T`Partes del proyecto`));
      p.append(h('div', { class: 'grid' }, kids.map((k) => h('button', { class: 'cat part', onclick: () => setScope(k.path) },
        h('span', { class: 'row' }, h('span', { class: 'dot ' + (k.st.sev || 'pass') }), h('span', { class: 'grow' }, partName(k)), k.comp && k.comp.kind ? h('span', { class: 'kind' }, k.comp.kind) : null),
        h('span', { class: 'nums' }, ['fail', 'risk', 'human'].filter((s) => k.st[s]).map((s) => h('span', { class: s }, plural(k.st[s], SEV1[s], SEVS[s]), ' ')), k.st.sev ? null : h('span', { class: 'pass' }, T`Sin avisos`)),
        S.mode === 'eng' ? h('span', { class: 'desc' }, (partName(k) !== k.label ? k.label + ' · ' : '') + T`${k.st.files} archivos · ${k.st.units} funciones`) : null))));
    }

    // Por área y qué se analizó: plegado salvo con detalles técnicos.
    const cats = S.onlyNew || S.scope ? recount() : d.categories;
    const flagged = cats.filter((cat) => cat.fail || cat.risk || cat.human).length;
    p.append(h('details', { class: 'fold', open: S.mode === 'eng' },
      h('summary', {}, T`Problemas por área`, h('span', { class: 'muted' }, ' · ' + T`${flagged} de ${cats.length} con avisos`)),
      h('div', { class: 'grid' }, cats.map((cat) => {
        const sev = cat.fail ? 'fail' : cat.human ? 'human' : cat.risk ? 'risk' : 'pass';
        const nums = ['fail', 'risk', 'human'].filter((k) => cat[k]).map((k) => h('span', { class: k }, plural(cat[k], SEV1[k], SEVS[k]), ' '));
        return h('button', { class: 'cat', onclick: () => set({ tab: 'problemas', cat: cat.id, sev: null, q: '', open: null }) },
          h('span', { class: 'row' }, h('span', { class: 'dot ' + sev }), cat.label),
          h('span', { class: 'nums' }, nums.length ? nums : h('span', { class: 'pass' }, T`Sin avisos`)),
          h('span', { class: 'desc' }, cat.desc));
      }))));

    if (S.scope) { const own = statsFor(S.scope); p.append(h('p', { class: 'muted' }, T`${own.files} archivos · ${own.units} funciones`, ' · ', h('button', { class: 'link', onclick: () => set({ tab: 'flow' }) }, T`Ver el mapa de esta parte`))); view.append(p); return; }
    const langs = Object.entries(st.languages).map(([k, v]) => `${k.replace('c_sharp', 'C#')} (${v})`).join(', ');
    const facts = [
      T`${st.sourceFiles} archivos de código leídos`, T`${st.units} funciones · ${st.lines.toLocaleString(LOC)} líneas`, langs || T`Sin lenguajes reconocidos`,
      T`${st.tests.testFiles} archivos de prueba`, T`Sin IA: mismo código, mismo resultado`, T`Analizado en ${d.durationMs} ms`,
    ].map((t) => h('li', {}, t));
    for (const t of st.tools.filter((x) => x.name !== 'tree-sitter')) facts.push(h('li', { class: t.ok && !t.partial ? '' : 'warn' }, `${t.name}: ${t.partial ? T`parcial (${t.detail})` : t.ok ? t.detail : T`no ejecutado (${t.detail})`}`));
    if (st.truncated) facts.push(h('li', { class: 'warn' }, T`Análisis parcial: se alcanzó el máximo de archivos`));
    if (st.unparsed) facts.push(h('li', { class: 'warn' }, T`${st.unparsed} archivos no se pudieron interpretar`));
    if (st.capped) facts.push(h('li', { class: 'warn' }, T`${st.capped} avisos repetidos no se muestran (máximo 200 por tipo)`));
    if (st.ignored) facts.push(h('li', { class: 'warn' }, T`${st.ignored} avisos ocultos por ti`));
    p.append(h('details', { class: 'fold', open: S.mode === 'eng' },
      h('summary', {}, T`Qué se analizó`, h('span', { class: 'muted' }, ' · ' + T`${st.sourceFiles} archivos`)),
      h('ul', { class: 'facts' }, facts),
      st.deep ? null : h('p', { class: 'muted host-only' }, h('button', { class: 'btn small', onclick: () => post({ type: 'deepScan' }) }, T`Análisis profundo`), T` Añade vulnerabilidades conocidas en librerías (npm audit) y, si están instalados, gitleaks y osv-scanner.`)));
    view.append(p);
  }
  function recount() {
    const m = new Map(S.data.categories.map((c) => [c.id, { ...c, fail: 0, risk: 0, human: 0 }]));
    for (const f of findings()) m.get(f.category)[f.severity]++;
    return [...m.values()];
  }

  // ───────────────────────── Actividad
  // Lo que pasa mientras trabajas, venga de VS Code, de IntelliJ o de tu aplicación en marcha.
  const isError = (e) => (e.type === 'api' && (!!e.error || e.status >= 400)) || e.type === 'log' || (e.type === 'files' && e.files.some((f) => f.newFindings.length));
  const isFailure = (e) => (e.type === 'api' && (!!e.error || e.status >= 500)) || e.type === 'log';
  function recentFailure() {
    const since = Date.now() - 15 * 60 * 1000;
    for (let i = S.act.events.length - 1; i >= 0; i--) { const e = S.act.events[i]; if (isFailure(e) && Date.parse(e.at) >= since) return e; }
    return null;
  }
  const failureTitle = (e) => (e.type === 'log' ? T`Tu aplicación registró un error: ${e.headline}` : e.error ? T`${e.method} ${e.path} no obtuvo respuesta` : T`Tu API respondió ${e.status} en ${e.method} ${e.path}`);
  const clock = (at) => new Date(at).toLocaleTimeString(LOC, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const STATUS_WORD = { modified: T`Modificado`, added: T`Nuevo`, deleted: T`Eliminado`, removed: T`Eliminado`, renamed: T`Renombrado`, untracked: T`Nuevo, sin Git`, conflict: T`En conflicto` };
  /** Lista de puntos del código implicados en un error, cada uno con su botón para abrirlo. */
  const frameList = (frames) => (frames && frames.length ? h('ul', { class: 'frames' }, frames.slice(0, S.mode === 'eng' ? 12 : 3).map((f) =>
    h('li', {}, h('button', { class: 'link mono', onclick: () => openFile(f.file, f.line) }, `${f.file}:${f.line}`), f.fn ? h('span', { class: 'muted' }, ' ' + f.fn.split('.').slice(-2).join('.')) : null))) : null);
  /** Un error de log cercano en el tiempo suele ser la causa de un 500: se muestra junto a él. */
  function relatedLog(e) {
    const t0 = Date.parse(e.at);
    return S.act.events.find((x) => x.type === 'log' && Math.abs(Date.parse(x.at) - t0) < 5000) || null;
  }
  function source(title, text, actions) {
    return h('div', { class: 'source' }, h('div', { class: 'source-title' }, title), h('div', { class: 'muted' }, text), actions && actions.length ? h('div', { class: 'actions' }, actions) : null);
  }
  function viewVivo(view) {
    const L = S.live, host = !!vscode;
    const p = h('div', { class: 'pad' });
    view.append(p);
    if (!host) { p.append(h('p', { class: 'muted' }, T`El modo en vivo solo está disponible dentro de VS Code.`)); return; }
    const running = L && (L.status === 'starting' || L.status === 'running');
    const STATUS = { starting: T`Arrancando`, running: T`En marcha`, failed: T`No arrancó`, exited: T`Terminó`, stopped: T`Detenida` };
    p.append(h('p', { class: 'muted' }, T`Compilar no basta: Spectator arranca tu aplicación, mira qué puertos abre y a qué se conecta, y prueba la API con peticiones pensadas para destapar errores que solo aparecen al ejecutar.`));
    p.append(h('div', { class: 'actions' },
      running ? null : h('button', { class: 'btn primary', onclick: () => post({ type: 'liveStart' }) }, L ? T`Arrancar de nuevo` : T`Arrancar y probar la API`),
      L && L.status === 'running' ? h('button', { class: 'btn', disabled: L.probing ? true : null, onclick: () => post({ type: 'liveReprobe' }) }, L.probing ? T`Probando…` : T`Probar la API otra vez`) : null,
      running ? h('button', { class: 'btn', onclick: () => post({ type: 'liveStop' }) }, T`Detener`) : null));
    if (!L) return;
    const kv = (k, v) => v ? h('div', {}, h('span', { class: 'muted' }, k + ' '), h('span', { class: 'mono' }, v)) : null;
    const sev = L.status === 'running' ? 'pass' : L.status === 'failed' ? 'fail' : L.status === 'starting' ? 'risk' : 'none';
    p.append(h('div', { class: 'sources' },
      h('div', { class: 'source' }, h('div', { class: 'source-title' }, h('span', { class: 'dot ' + sev }), ' ', STATUS[L.status] || L.status, L.phase ? h('span', { class: 'muted' }, ' · ' + L.phase) : null),
        kv('PID', L.pid ? String(L.pid) : ''), kv(T`Listo en`, L.readyMs ? (L.readyMs / 1000).toFixed(1) + ' s' : ''), L.error ? h('div', { class: 'mono' }, L.error) : null, L.portNote ? h('div', { class: 'muted' }, L.portNote) : null),
      h('div', { class: 'source' }, h('div', { class: 'source-title' }, T`Puertos y conexiones`),
        kv(T`HTTP`, L.port ? 'http://localhost:' + L.port : ''), kv(T`Escuchando`, (L.ports || []).join(', ')), kv(T`Base de datos`, L.datasource), kv(T`Consola H2`, L.h2Console && L.port ? 'http://localhost:' + L.port + L.h2Console : ''), kv(T`Conexiones salientes`, (L.connections || []).join(', '))),
      h('div', { class: 'source' }, h('div', { class: 'source-title' }, T`Endpoints: ${L.endpoints.length}`), h('div', { class: 'muted' }, T`Descubiertos en: ${L.discovery}`))));
    if (L.shadow) p.append(h('p', { class: 'notice' }, T`Tu código no arranca tal como está. Para seguir probando, Spectator arrancó una copia temporal con este arreglo provisional: ${L.shadow.fixes.map((x) => x.from + ' → ' + x.to).join(', ')}. Tu código no se modificó: el arreglo de verdad lo haces tú.`,
      ' ', ...L.shadow.fixes.map((x) => h('button', { class: 'link', onclick: () => openFile(x.file, x.line) }, base(x.file) + ':' + x.line))));
    if (L.offlineNote) p.append(h('p', { class: 'muted' }, L.offlineNote));
    if (L.blockedNote) p.append(h('p', { class: 'notice' }, L.blockedNote));
    if (L.needs && L.needs.length) {
      p.append(h('h2', {}, T`Falta configuración`));
      p.append(h('p', { class: 'muted' }, T`Sin esto Spectator no puede ejecutar tu aplicación ni probar su API; solo funciona el análisis estático. Aquí tienes dónde escribir cada dato.`));
      const KIND = { db: T`Base de datos`, env: T`Variable`, secret: T`Clave`, service: T`Servicio`, driver: T`Driver`, deps: T`Dependencias` };
      const node = L.kind === 'node-express';
      const place = (n) => n.kind === 'deps' ? T`Ejecuta npm install en la carpeta del proyecto.`
        : node && n.kind === 'env' ? (n.envFile ? T`Añade ${n.key}=… a ${n.envFile} (se usa en ${n.file}, línea ${n.line}).` : T`Define la variable de entorno ${n.key} (se usa en ${n.file}, línea ${n.line}).`)
        : n.kind === 'db' && n.host ? T`Arranca la base de datos o corrige la dirección en ${n.file}, línea ${n.line}.`
        : n.kind === 'driver' ? T`Añade la dependencia en ${n.file} (línea ${n.line}).` : n.add ? T`Añádelo en ${n.file} como ${n.key}=…` : T`Escríbelo en ${n.file}, línea ${n.line}.`;
      p.append(h('div', { class: 'list' }, L.needs.map((n) => h('div', { class: 'item' }, h('div', { class: 'head' },
        h('span', { class: 'dot human' }),
        h('span', { class: 'title' }, h('b', {}, KIND[n.kind] + ': '), h('span', { class: 'mono' }, n.key), n.what && n.what !== n.key ? h('span', { class: 'muted mono' }, ' = ' + n.what) : null,
          h('div', { class: 'muted' }, place(n), n.env && n.kind !== 'driver' && !node ? ' ' + T`O define la variable de entorno ${n.env}.` : '', n.proven ? ' ' + T`(confirmado por el log)` : '')),
        h('button', { class: 'btn small primary', onclick: () => openFile(n.file, n.line) }, T`Abrir`))))));
    }
    if (L.writesNote) p.append(h('p', { class: 'notice' }, L.writesNote));
    // La configuración que falta ya tiene su propia lista arriba.
    const proven = L.findings.filter((f) => f.rule !== 'live-needs-config');
    if (proven.length) {
      p.append(h('h2', {}, T`Fallos demostrados al ejecutar`));
      const box = h('div', { class: 'list' });
      for (const f of proven) {
        const open = S.open === f.id;
        box.append(h('div', { class: 'item' },
          h('button', { class: 'head', 'aria-expanded': String(open), onclick: () => set({ open: open ? null : f.id }) }, h('span', { class: 'dot ' + f.severity }), h('span', { class: 'title' }, f.title), h('span', { class: 'where' }, base(f.file) + ':' + f.line)),
          open ? h('div', { class: 'detail' }, h('p', {}, f.why), h('p', {}, h('b', {}, T`Qué hacer: `), f.action), h('pre', { class: 'mono' }, [f.tech, ...(f.evidence || [])].filter(Boolean).join('\n')),
            h('div', { class: 'actions' }, h('button', { class: 'btn small primary', onclick: () => openFile(f.file, f.line) }, T`Abrir`), ...(f.related || []).map((r) => h('button', { class: 'btn small', onclick: () => openFile(r.file, r.line) }, base(r.file) + ':' + r.line)))) : null));
      }
      p.append(box);
    }
    if (L.endpoints.length) {
      p.append(h('h2', {}, T`Endpoints`));
      p.append(h('table', { class: 'live' }, h('tbody', {}, L.endpoints.map((e) => h('tr', {},
        h('td', { class: 'mono' }, e.method), h('td', { class: 'mono' }, e.path),
        h('td', {}, e.file ? h('button', { class: 'link mono', onclick: () => openFile(e.file, e.line) }, base(e.file) + ':' + e.line) : h('span', { class: 'muted' }, e.source)))))));
    }
    if (L.requests.length) {
      p.append(h('h2', {}, T`Peticiones de prueba`));
      p.append(h('table', { class: 'live' },
        h('thead', {}, h('tr', {}, h('th', {}, T`Método`), h('th', {}, 'URL'), h('th', {}, T`Código`), h('th', {}, T`Tiempo`), h('th', {}, T`Para qué`))),
        h('tbody', {}, L.requests.map((r) => h('tr', {},
          h('td', { class: 'mono' }, r.method), h('td', { class: 'mono' }, r.url),
          h('td', { class: 'mono code ' + (r.status >= 500 || r.error ? 'fail' : r.status >= 400 ? 'risk' : 'pass') }, r.status ? String(r.status) : '—'),
          h('td', { class: 'mono' }, r.ms != null ? r.ms + ' ms' : '…'),
          h('td', {}, r.why, r.note ? h('div', { class: 'muted' }, r.note) : null, r.log ? h('div', { class: 'muted mono' }, r.log) : null))))));
    }
    p.append(h('h2', {}, T`Consola`));
    const c = h('pre', { class: 'console live-console' }, (L.output || '').split('\n').slice(-200).join('\n'));
    p.append(c);
    setTimeout(() => { c.scrollTop = c.scrollHeight; }, 0);
  }
  function viewActividad(view) {
    const A = S.act, pro = S.mode === 'eng', host = !!vscode;
    const ch = S.data.changes || { files: [] };
    const p = h('div', { class: 'pad' });
    const sources = h('div', { class: 'sources' });
    sources.append(source(T`Tus archivos`,
      host ? T`Spectator vuelve a analizar cuando cambias un archivo aquí, en IntelliJ o en cualquier otro editor.` : T`Cambios respecto al último commit de Git.`,
      ch.git && ch.git.branch ? [h('span', { class: 'muted' }, T`Rama ${ch.git.branch}`)] : null));
    if (host) {
      if (A.api) {
        sources.append(source(T`Tu API`, T`Llama a ${A.api.url} en lugar de ${A.api.target}. Las peticiones llegan igual a tu servidor y aquí ves cada respuesta.`, [
          h('button', { class: 'btn small', onclick: () => navigator.clipboard && navigator.clipboard.writeText(A.api.url) }, T`Copiar dirección`),
          h('button', { class: 'btn small', onclick: () => post({ type: 'stopApi' }) }, T`Dejar de vigilar`)]));
      } else {
        const target = h('input', { type: 'text', value: (A.guess && A.guess.url) || '', 'aria-label': T`URL de tu servidor`, placeholder: 'http://localhost:8080' });
        sources.append(source(T`Tu API`, T`Mira cada llamada a tu servidor y entiende por qué falla: 500, 404, 401…`, [
          target, h('button', { class: 'btn small primary', onclick: () => post({ type: 'watchApi', target: target.value }) }, T`Vigilar la API`)]));
      }
      sources.append(source(T`Errores del log`, A.logs.length ? T`Leyendo ${A.logs.join(', ')}` : T`Si tu aplicación escribe un log (por ejemplo, Spring arrancado desde IntelliJ), Spectator lee sus errores y te lleva a la línea.`, [
        h('button', { class: 'btn small', onclick: () => post({ type: 'pickLogs' }) }, A.logs.length ? T`Añadir otro log` : T`Elegir archivo de log`),
        A.logs.length ? h('button', { class: 'btn small', onclick: () => post({ type: 'stopLogs' }) }, T`Dejar de leer`) : null]));
    }
    p.append(sources);

    // Archivos que estás cambiando (Git y cambios desde el último análisis), con su posible impacto.
    if (ch.files.length) {
      p.append(h('h2', {}, T`Archivos que estás cambiando`));
      const box = h('div', { class: 'list' });
      for (const f of ch.files.slice(0, pro ? 100 : 20)) {
        const key = 'c:' + f.rel, open = A.open === key;
        const n = f.findings.fail + f.findings.risk + f.findings.human;
        const sev = f.findings.fail ? 'fail' : f.findings.human ? 'human' : f.findings.risk ? 'risk' : 'pass';
        const row = h('div', { class: 'item' }, h('button', { class: 'head', 'aria-expanded': String(open), onclick: () => set({ act: { ...A, open: open ? null : key } }) },
          h('span', { class: 'dot ' + sev }),
          h('span', { class: 'title' }, base(f.rel), h('span', { class: 'muted' }, ' ' + f.rel.split('/').slice(0, -1).join('/'))),
          h('span', { class: 'where' }, [STATUS_WORD[f.git || f.sinceLastScan] || '', f.added || f.removed ? ` +${f.added || 0} −${f.removed || 0}` : ''].join(''))));
        if (open) {
          const det = h('div', { class: 'detail' });
          det.append(h('p', {}, n ? (n === 1 ? T`Tiene 1 aviso.` : T`Tiene ${n} avisos.`) : T`Sin avisos en este archivo.`, ' ',
            f.dependentsCount ? (f.dependentsCount === 1 ? T`1 archivo depende de él y podría verse afectado.` : T`${f.dependentsCount} archivos dependen de él y podrían verse afectados.`) + (f.dependentsTruncated ? ' ' + T`(búsqueda limitada)` : '') : T`Ningún otro archivo depende de él.`));
          if (f.newFindings && f.newFindings.length) det.append(h('div', {}, h('b', {}, T`Nuevo desde el último análisis`), h('ul', { class: 'plain' }, f.newFindings.map((x) => h('li', {}, h('span', { class: 'dot ' + x.severity }), ' ', h('button', { class: 'link', onclick: () => set({ tab: 'problemas', open: x.id, sev: null, cat: '', q: '' }) }, x.title))))));
          if (f.dependents.length) det.append(h('div', {}, h('b', {}, T`Pueden verse afectados`), h('ul', { class: 'plain' }, f.dependents.slice(0, pro ? 20 : 6).map((rel) => h('li', {}, h('button', { class: 'link mono', onclick: () => openFile(rel, 1) }, rel))))));
          const idx = S.data.graph.files.findIndex((g) => g.rel === f.rel);
          det.append(h('div', { class: 'actions host-only' },
            f.git !== 'deleted' && f.sinceLastScan !== 'removed' ? h('button', { class: 'btn small primary', onclick: () => openFile(f.rel, 1) }, T`Abrir`) : null,
            idx >= 0 ? h('button', { class: 'btn small', onclick: () => { S.scope = ''; Object.assign(S.flow, { focus: idx, sel: null }); set({ tab: 'flow' }); } }, T`Ver sus conexiones`) : null));
          row.append(det);
        }
        box.append(row);
      }
      p.append(box);
      if (ch.files.length > (pro ? 100 : 20)) p.append(h('p', { class: 'muted' }, T`Y ${ch.files.length - (pro ? 100 : 20)} archivos más.`));
    }

    // Línea de tiempo: lo más reciente arriba.
    const shown = A.events.filter((e) => (A.filter !== 'errors' || isError(e)) && (pro && A.assets || !(e.type === 'api' && e.asset))).slice(-150).reverse();
    p.append(h('div', { class: 'timeline-head' }, h('h2', {}, T`Lo que ha pasado`),
      h('div', { class: 'seg', role: 'group', 'aria-label': T`Qué mostrar` },
        h('button', { 'aria-pressed': String(A.filter !== 'errors'), onclick: () => set({ act: { ...A, filter: 'all' } }) }, T`Todo`),
        h('button', { 'aria-pressed': String(A.filter === 'errors'), onclick: () => set({ act: { ...A, filter: 'errors' } }) }, T`Solo errores`)),
      pro ? h('button', { class: 'chip', 'aria-pressed': String(A.assets), title: T`Imágenes, estilos y scripts que pide el navegador`, onclick: () => set({ act: { ...A, assets: !A.assets } }) }, T`Archivos estáticos`) : null,
      A.events.length ? h('button', { class: 'btn small host-only', onclick: () => post({ type: 'clearActivity' }) }, T`Vaciar`) : null));
    if (!shown.length) {
      p.append(h('div', { class: 'list' }, h('div', { class: 'empty' }, h('b', {}, A.filter === 'errors' && A.events.length ? T`Ningún error por ahora` : T`Todavía no ha pasado nada`),
        host ? T`Cambia un archivo, aquí o en IntelliJ, o vigila tu API para ver cada llamada.` : T`La actividad en vivo solo está disponible dentro de VS Code.`)));
    } else p.append(h('ol', { class: 'timeline', 'aria-label': T`Actividad reciente` }, shown.map((e) => eventRow(e, pro))));
    view.append(p);
  }
  function eventRow(e, pro) {
    const open = S.act.open === e.id;
    const toggle = () => set({ act: { ...S.act, open: open ? null : e.id } });
    let badge, cls, title, sub;
    if (e.type === 'api') {
      const lvl = e.explanation.level;
      cls = lvl === 'server' || lvl === 'network' ? 'fail' : lvl === 'client' ? 'risk' : lvl === 'redirect' ? 'info' : 'pass';
      badge = e.status || T`sin respuesta`;
      title = [h('span', { class: 'mono method' }, e.method), ' ', h('span', { class: 'mono' }, e.path)];
      sub = e.explanation.title + (pro ? ` · ${e.ms} ms` : '');
    } else if (e.type === 'log') {
      cls = 'fail'; badge = T`log`; title = e.headline || T`Error en el log`; sub = e.cause || e.log;
    } else {
      const fresh = e.files.reduce((n, f) => n + f.newFindings.length, 0), fixed = e.files.reduce((n, f) => n + f.fixedFindings, 0);
      cls = fresh ? 'risk' : 'muted'; badge = T`cambio`;
      title = e.files.length === 1 ? base(e.files[0].rel) : T`${e.files.length} archivos`;
      sub = [e.source === 'external' ? T`desde otro editor o herramienta` : T`guardado en VS Code`, fresh ? (fresh === 1 ? T`1 aviso nuevo` : T`${fresh} avisos nuevos`) : null, fixed ? (fixed === 1 ? T`1 aviso resuelto` : T`${fixed} avisos resueltos`) : null].filter(Boolean).join(' · ');
    }
    // El nivel va en un atributo y no como clase: las clases de gravedad colorean todo el texto que contienen.
    const li = h('li', { class: 'event', 'data-level': cls, id: 'e-' + e.id },
      h('button', { class: 'event-head', 'aria-expanded': String(open), onclick: toggle },
        h('span', { class: 'code', 'data-level': cls, 'data-word': e.type === 'api' && e.status ? null : 'true' }, String(badge)),
        h('span', { class: 'event-main' }, h('span', { class: 'event-title' }, title), h('span', { class: 'muted' }, sub)),
        h('time', { class: 'muted', datetime: e.at }, clock(e.at))));
    if (open) li.append(eventDetail(e, pro));
    return li;
  }
  function eventDetail(e, pro) {
    const dl = h('dl', {});
    const el = h('div', { class: 'detail' }, dl);
    if (e.type === 'api') {
      const x = e.explanation;
      dl.append(h('dt', {}, T`Qué significa`), h('dd', {}, h('b', {}, `${x.label}. `), x.meaning));
      if (e.message) dl.append(h('dt', {}, T`El servidor dice`), h('dd', {}, e.message));
      dl.append(h('dt', {}, T`Qué revisar`), h('dd', {}, x.check));
      const log = (!e.frames || !e.frames.length) && (e.error || e.status >= 500) ? relatedLog(e) : null;
      const frames = e.frames && e.frames.length ? e.frames : log ? log.frames : [];
      if (frames.length) dl.append(h('dt', {}, T`Dónde falló`), h('dd', {}, frameList(frames)));
      if (log) dl.append(h('dt', {}, T`En el log`), h('dd', {}, log.headline, log.cause ? h('div', { class: 'muted' }, T`Causa: ${log.cause}`) : null));
      if (!frames.length && (e.error || e.status >= 500)) dl.append(h('dt', {}, T`Para saber más`), h('dd', { class: 'muted' }, T`El servidor no envió su traza. Elige el archivo de log de tu aplicación en «Errores del log» y Spectator te llevará a la línea del error.`));
      if (pro) {
        dl.append(h('dt', {}, T`Petición`), h('dd', { class: 'mono' }, `${e.method} ${e.path} · ${e.ms} ms${e.contentType ? ' · ' + e.contentType : ''}`));
        if (e.body) el.append(h('pre', {}, e.body));
      }
    } else if (e.type === 'log') {
      if (e.cause) dl.append(h('dt', {}, T`Causa`), h('dd', {}, e.cause));
      if (e.frames.length) dl.append(h('dt', {}, T`Dónde falló`), h('dd', {}, frameList(e.frames)));
      else dl.append(h('dt', {}, T`Dónde falló`), h('dd', { class: 'muted' }, T`La traza no menciona archivos de este proyecto: el error ocurrió en una librería o en la configuración.`));
      dl.append(h('dt', {}, T`Log`), h('dd', { class: 'mono' }, e.log));
      if (pro && e.text) el.append(h('pre', {}, e.text));
    } else {
      dl.append(h('dt', {}, T`Archivos`), h('dd', {}, h('ul', { class: 'plain' }, e.files.map((f) => h('li', {},
        h('button', { class: 'link mono', onclick: () => openFile(f.rel, 1) }, f.rel), h('span', { class: 'muted' }, ' ' + (STATUS_WORD[f.kind] || '')),
        f.newFindings.length ? h('ul', { class: 'plain nested' }, f.newFindings.map((x) => h('li', {}, h('span', { class: 'dot ' + x.severity }), ' ',
          h('button', { class: 'link', onclick: () => set({ tab: 'problemas', open: x.id, sev: null, cat: '', q: '' }) }, x.title)))) : null)))));
    }
    return el;
  }

  // ───────────────────────── Mapa del backend
  // El backend explicado: qué endpoints hay, qué recibe y devuelve cada uno, por dónde pasa y qué es cada pieza.
  const WHERE = { path: () => T`en la URL`, body: () => T`en el cuerpo (JSON)`, query: () => T`como parámetro de la URL (?nombre=)`, header: () => T`en una cabecera` };
  const STATUS_TEXT = { 200: () => T`correcto`, 201: () => T`creado`, 204: () => T`sin contenido`, 400: () => T`datos incorrectos`, 401: () => T`sin sesión`, 403: () => T`sin permiso`, 404: () => T`no existe`, 409: () => T`conflicto`, 500: () => T`error del servidor` };
  const statusText = (n) => `${n} ${(STATUS_TEXT[n] || (() => ''))()}`.trim();
  const ROLE_GROUP = [['controller', () => T`Controladores`], ['service', () => T`Servicios`], ['repository', () => T`Repositorios`], ['entity', () => T`Entidades`], ['dto', () => T`DTO`], ['mapper', () => T`Conversores`], ['client', () => T`Clientes de otras APIs`], ['handler', () => T`Manejadores de errores`], ['exception', () => T`Excepciones`], ['routes', () => T`Rutas`], ['middleware', () => T`Middleware`], ['model', () => T`Modelos`], ['config', () => T`Configuración`], ['app', () => T`Arranque`], ['other', () => T`Otros`]];
  /** Avisos que caen dentro de un archivo (y, si se indica, entre dos líneas). */
  const findingsIn = (file, from, to) => S.data.findings.filter((f) => f.file === file && (from == null || (f.line >= from && f.line <= (to || from))));
  function dtoCard(d) {
    const kind = { request: T`entra por la API`, response: T`sale por la API`, external: T`lo devuelve otra API`, dto: d.unused ? T`no se usa` : T`datos internos` }[d.kind];
    return h('div', { class: 'dto' },
      h('div', { class: 'dto-head' }, h('b', { class: 'mono' }, d.name), h('span', { class: 'muted' }, ' — ' + kind), h('button', { class: 'link host-only', onclick: () => openFile(d.file, d.line) }, T`Abrir`)),
      d.fields.length ? h('table', { class: 'fields' }, h('tbody', {}, d.fields.map((f) => h('tr', {}, h('td', { class: 'mono' }, f.name), h('td', { class: 'mono muted' }, f.type), h('td', {}, f.rules.join(', ')))))) : h('div', { class: 'muted' }, T`Sin campos.`),
      d.input.length || d.output.length || d.createdIn.length || (d.fromExternal || []).length ? h('div', { class: 'muted small' },
        [d.input.length ? T`Entra en: ${d.input.join(', ')}` : null, d.output.length ? T`Sale de: ${d.output.join(', ')}` : null, d.createdIn.length ? T`Lo crea: ${d.createdIn.join(', ')}` : null, (d.fromExternal || []).length ? T`Lo recibe: ${d.fromExternal.join(', ')}` : null].filter(Boolean).join(' · ')) : null);
  }
  function viewBackend(view) {
    const B = S.data.backend, pro = S.mode === 'eng';
    const p = h('div', { class: 'pad' });
    if (!B) {
      p.append(h('div', { class: 'empty' }, h('b', {}, T`No reconozco un backend en esta carpeta`), T`El mapa del backend entiende Spring Boot, Express, NestJS, Next.js, FastAPI, Flask y Django. La subvista «Código» muestra igualmente los archivos, las funciones y sus conexiones.`));
      view.append(p); return;
    }
    const dtoByName = new Map((B.dtos || []).map((d) => [d.name, d]));
    const FW = { spring: 'Spring Boot', express: 'Express', nestjs: 'NestJS', nextjs: 'Next.js', fastapi: 'FastAPI', flask: 'Flask', django: 'Django' };
    p.append(h('p', { class: 'lead' }, T`Tu backend en palabras sencillas. Elige un endpoint para ver qué recibe, por dónde pasa y qué devuelve.`),
      h('p', { class: 'muted small' }, T`Proyecto ${FW[B.framework] || B.framework}`),
      h('p', { class: 'muted' }, [plural(B.endpoints.length, T`endpoint`, T`endpoints`), plural(B.components.length, T`pieza`, T`piezas`), plural((B.dtos || []).length, T`DTO`, T`DTO`), plural((B.externals || []).length, T`API externa`, T`APIs externas`)].join(' · ')));
    // Endpoints: la puerta de entrada.
    p.append(h('h2', {}, T`Endpoints`));
    if (!B.endpoints.length) p.append(h('div', { class: 'list' }, h('div', { class: 'empty' }, h('b', {}, T`No encontré endpoints`), T`Si tu backend define rutas de otra forma, todavía no sé leerla.`)));
    const box = h('div', { class: 'list' });
    B.endpoints.forEach((e, i) => {
      const key = 'e' + i, open = S.be.open === key;
      const bad = e.steps.some((st) => findingsIn(st.file, st.line, st.line + 40).some((f) => f.severity === 'fail')) || findingsIn(e.file, e.line, e.line).length;
      const row = h('div', { class: 'item' }, h('button', { class: 'head', 'aria-expanded': String(open), onclick: () => set({ be: { ...S.be, open: open ? null : key } }) },
        h('span', { class: 'verb mono ' + e.method.toLowerCase() }, e.method),
        h('span', { class: 'title' }, h('span', { class: 'mono' }, e.path), h('div', { class: 'muted small' }, e.output.empty ? statusText(e.output.status) : `${e.output.text} · ${statusText(e.output.status)}`)),
        bad ? h('span', { class: 'dot fail', title: T`Tiene avisos` }) : null));
      if (open) row.append(endpointDetail(e, dtoByName, pro));
      box.append(row);
    });
    if (B.endpoints.length) p.append(box);
    // Piezas por papel.
    p.append(h('h2', {}, T`Piezas del backend`));
    for (const [role, label] of ROLE_GROUP) {
      const list = B.components.filter((c) => c.role === role);
      if (!list.length) continue;
      const info = (B.roles || []).find((r) => r.role === role) || {};
      p.append(h('details', { class: 'fold role', open: role === 'controller' || role === 'service' || pro },
        h('summary', {}, `${label()} · ${list.length}`),
        h('p', { class: 'muted' }, info.what || ''),
        h('div', { class: 'grid' }, list.map((c) => {
          const issues = findingsIn(c.file);
          return h('button', { class: 'cat', onclick: () => openFile(c.file, c.line), title: c.file },
            h('span', { class: 'row' }, h('span', { class: 'dot ' + (issues.some((f) => f.severity === 'fail') ? 'fail' : issues.length ? 'risk' : 'pass') }), h('span', { class: 'grow mono' }, c.name)),
            c.deps.length ? h('span', { class: 'desc' }, T`Usa: ${c.deps.map((x) => x.split('/').pop()).join(', ')}`) : null,
            c.usedBy.length ? h('span', { class: 'desc' }, T`Lo usa: ${c.usedBy.map((x) => x.split('/').pop()).join(', ')}`) : null,
            issues.length ? h('span', { class: 'desc risk' }, plural(issues.length, T`aviso`, T`avisos`)) : null);
        }))));
    }
    // DTO y entidades.
    if ((B.dtos || []).length) {
      p.append(h('h2', {}, T`DTO: los datos que entran y salen`));
      p.append(h('p', { class: 'muted' }, T`Un DTO es la forma de los datos que viajan por la API. Cada campo dice qué regla cumple.`));
      p.append(h('div', { class: 'dtos' }, B.dtos.map(dtoCard)));
    }
    if ((B.entities || []).length) {
      p.append(h('h2', {}, T`Entidades: las tablas de la base de datos`));
      const relText = (en, f) => {
        const r = f.relation;
        if (!r) return f.id ? T`identificador` : '';
        if (r.kind === 'ManyToOne') return T`cada ${en.name} pertenece a un ${r.target}`;
        if (r.kind === 'OneToOne') return T`cada ${en.name} tiene un ${r.target}`;
        if (r.kind === 'OneToMany') return T`un ${en.name} tiene varios ${r.target}`;
        return T`varios ${en.name} con varios ${r.target}`;
      };
      p.append(h('div', { class: 'dtos' }, B.entities.map((en) => h('div', { class: 'dto' },
        h('div', { class: 'dto-head' }, h('b', { class: 'mono' }, en.name), en.table ? h('span', { class: 'muted' }, ' — ' + T`tabla ${en.table}`) : null, h('button', { class: 'link host-only', onclick: () => openFile(en.file, en.line) }, T`Abrir`)),
        h('table', { class: 'fields' }, h('tbody', {}, en.fields.map((f) => h('tr', {}, h('td', { class: 'mono' }, f.name), h('td', { class: 'mono muted' }, f.type), h('td', {}, relText(en, f))))))))));
    }
    if ((B.externals || []).length) {
      p.append(h('h2', {}, T`Otras APIs a las que llama`));
      p.append(h('div', { class: 'list' }, B.externals.map((x) => h('div', { class: 'item' }, h('button', { class: 'head', onclick: () => openFile(x.file, x.line) },
        h('span', { class: 'verb mono ' + x.method.toLowerCase() }, x.method), h('span', { class: 'title mono' }, x.url), h('span', { class: 'where mono' }, x.from))))));
    }
    p.append(h('details', { class: 'fold', open: !pro }, h('summary', {}, T`¿Qué significa cada palabra?`),
      h('dl', { class: 'glossary' }, (B.glossary || []).map((g) => [h('dt', {}, g.term), h('dd', {}, g.text)]))));
    view.append(p);
  }
  function endpointDetail(e, dtoByName, pro) {
    const el = h('div', { class: 'detail journey' });
    el.append(h('p', { class: 'summary' }, e.summary));
    // Entra
    el.append(h('h4', {}, T`Qué recibe`));
    if (!e.inputs.length) el.append(h('p', { class: 'muted' }, T`Nada: no hace falta enviar datos.`));
    for (const i of e.inputs) {
      const d = i.dto && dtoByName.get(i.dto);
      el.append(h('div', { class: 'io' }, h('span', { class: 'mono' }, i.dto || i.entity || i.name), ' ', h('span', { class: 'muted' }, WHERE[i.where] ? WHERE[i.where]() : ''),
        i.where === 'body' && i.dto && !i.validated && d && d.fields.some((f) => f.rules.length) ? h('span', { class: 'fail' }, ' · ' + T`no se valida (falta @Valid)`) : null,
        i.fields ? h('span', { class: 'muted' }, ' · ' + i.fields.join(', ')) : null));
      if (d) el.append(dtoCard(d));
    }
    // Recorrido
    el.append(h('h4', {}, T`Por dónde pasa`));
    const ol = h('ol', { class: 'steps' });
    for (const st of e.steps) {
      const issues = st.kind === 'method' ? findingsIn(st.file, st.line, st.line + 40) : [];
      const what = st.kind === 'db' ? T`${st.verb} en la base de datos` + (st.builtin ? ' · ' + T`método que ya trae Spring Data` : '')
        : st.kind === 'external' ? T`llama a ${st.method} ${st.url}` + (st.dto ? ' · ' + T`recibe ${st.dto}` : '')
          : st.kind === 'missing' ? T`este método no existe` : (st.returns && st.returns !== T`nada` ? T`devuelve ${st.returns}` : '');
      ol.append(h('li', { class: 'step ' + st.kind, style: `margin-left:${st.depth * 18}px` },
        h('span', { class: 'chip role-' + st.role }, st.roleName),
        h('span', { class: 'mono' }, st.kind === 'external' ? '' : `${st.cls}.${st.method}`), what ? h('span', { class: 'muted' }, ' — ' + what) : null,
        st.file ? h('button', { class: 'link host-only', onclick: () => openFile(st.file, st.line) }, T`Abrir`) : null,
        issues.length ? h('div', {}, issues.map((f) => h('button', { class: 'link ' + f.severity, onclick: () => set({ tab: 'problemas', open: f.id, sev: null, cat: '', q: '' }) }, '! ' + f.title))) : null,
        pro && st.kind === 'method' ? h('div', { class: 'muted mono small' }, `${st.file}:${st.line}`) : null));
    }
    el.append(ol);
    // Sale
    el.append(h('h4', {}, T`Qué devuelve`));
    const outDto = e.output.cls && dtoByName.get(e.output.cls);
    el.append(h('div', { class: 'io' }, e.output.empty ? T`Nada (solo el código)` : h('span', { class: 'mono' }, e.output.text), ' · ', h('b', {}, statusText(e.output.status)),
      e.output.role === 'entity' ? h('span', { class: 'risk' }, ' · ' + T`es una entidad, no un DTO: expone tu base de datos`) : null));
    if (outDto) el.append(dtoCard(outDto));
    if (e.errors.length) {
      el.append(h('h4', {}, T`Cuando algo falla`));
      el.append(h('ul', { class: 'plain' }, e.errors.map((x) => h('li', { class: x.handled === false || x.status >= 500 ? 'fail' : '' },
        x.nullBody ? T`Si no encuentra el registro responde 200 con el cuerpo vacío.` : x.exception
          ? (x.handled ? T`${x.exception} → ${statusText(x.status)} (lo convierte ${x.by})` : T`${x.exception} → ${statusText(x.status)}: nadie lo maneja`)
          : T`Puede responder ${statusText(x.status)}`))));
    }
    // Pruébalo: una petición lista para copiar. Si el vigía de API está activo, va a través de él y aparece en Actividad.
    if (e.example) {
      const viaWatch = S.act.api && S.data.backend && S.data.backend.baseUrl;
      const curl = viaWatch ? e.example.curl.replace(S.data.backend.baseUrl, S.act.api.url) : e.example.curl;
      el.append(h('h4', {}, T`Pruébalo`),
        h('p', { class: 'muted small' }, viaWatch ? T`Pega esto en una terminal con tu aplicación arrancada. Pasa por el vigía de API, así que verás la respuesta explicada en Actividad.` : T`Pega esto en una terminal con tu aplicación arrancada. Los valores son de prueba.`),
        h('pre', { class: 'mono' }, curl),
        h('p', {}, T`Debería responder ${statusText(e.example.expect)}.`, e.example.errors.length ? ' ' + T`Si algo falla, puede responder ${e.example.errors.map(statusText).join(', ')}.` : ''),
        h('div', { class: 'actions' }, h('button', { class: 'btn small', onclick: () => navigator.clipboard && navigator.clipboard.writeText(curl) }, T`Copiar la petición`)));
    }
    el.append(h('div', { class: 'actions host-only' }, h('button', { class: 'btn small primary', onclick: () => openFile(e.file, e.line) }, T`Abrir el endpoint`)));
    return el;
  }

  // ───────────────────────── Cronología
  // Cada archivo que cambió hoy, cuándo y quién lo cambió (una IA, si consta en su registro).
  const SOURCE = { vscode: () => T`guardado en VS Code`, external: () => T`desde otro editor o herramienta`, 'claude-log': () => T`registro de Claude Code`, 'codex-log': () => T`registro de Codex`, 'claude-bash': () => T`orden de terminal de Claude Code`, git: () => T`commit de Git` };
  const ACTION = { edit: () => T`editó`, write: () => T`escribió entero`, create: () => T`creó`, delete: () => T`borró` };
  function viewCronologia(view) {
    const C = S.chrono, host = !!vscode, pro = S.mode === 'eng';
    const p = h('div', { class: 'pad' });
    if (!host) { p.append(h('div', { class: 'empty' }, h('b', {}, T`La cronología solo está disponible dentro de VS Code`), T`Abre el proyecto en VS Code para ver qué archivos cambian y quién los cambia.`)); view.append(p); return; }
    if (!C.data) { post({ type: 'chronology' }); p.append(h('div', { class: 'empty' }, h('b', {}, T`Leyendo la cronología de hoy…`))); view.append(p); return; }
    const D = C.data;
    p.append(h('p', { class: 'lead' }, T`Cada archivo que cambió hoy, cuándo y quién lo cambió.`),
      h('p', { class: 'muted small' }, D.aiLogs ? T`Para saber qué IA hizo cada cambio, Spectator lee los registros de Claude Code y Codex de este ordenador y los commits de Git firmados por una IA. Solo lee rutas, horas y el fragmento cambiado, nunca tus conversaciones. Si una herramienta no deja registro (por ejemplo Copilot o Cursor), el cambio aparece como «sin IA detectada».`
        : T`La lectura de los registros de IA está desactivada (ajuste spectator.chronology.aiLogs): solo se ven los cambios que Spectator observa.`));
    if (D.error) p.append(h('p', { class: 'stale' }, D.error));
    // Quién ha cambiado cosas hoy.
    const agentLabel = (who) => who || T`Sin IA detectada`;
    p.append(h('div', { class: 'filters' },
      h('button', { class: 'chip', 'aria-pressed': String(!C.who), onclick: () => set({ chrono: { ...C, who: '' } }) }, T`Todos · ${D.total}`),
      D.agents.map((a) => h('button', { class: 'chip', 'aria-pressed': String(C.who === (a.who || '-')), onclick: () => set({ chrono: { ...C, who: C.who === (a.who || '-') ? '' : a.who || '-' } }) },
        h('span', { class: 'agent ' + (a.who ? 'ai' : 'none') }), `${agentLabel(a.who)} · ` + T`${a.edits} cambios en ${a.files} archivos`)),
      h('div', { class: 'spacer' }),
      h('div', { class: 'seg', role: 'group', 'aria-label': T`Ordenar` },
        h('button', { 'aria-pressed': String(C.by !== 'file'), onclick: () => set({ chrono: { ...C, by: 'time' } }) }, T`Por hora`),
        h('button', { 'aria-pressed': String(C.by === 'file'), onclick: () => set({ chrono: { ...C, by: 'file' } }) }, T`Por archivo`)),
      h('button', { class: 'btn small', onclick: () => { post({ type: 'chronology' }); } }, T`Actualizar`)));
    const list = D.entries.filter((e) => !C.who || (e.who || '-') === C.who);
    if (!list.length) { p.append(h('div', { class: 'list' }, h('div', { class: 'empty' }, h('b', {}, T`Hoy no ha cambiado ningún archivo de este proyecto`), T`Cuando tú o una IA cambiéis un archivo, aparecerá aquí con la hora.`))); view.append(p); return; }
    const backendFiles = new Map(((S.data.backend && S.data.backend.components) || []).map((c) => [c.file, c]));
    const entryRow = (e, i, showFile) => {
      const key = 'c' + i + e.at + e.file, open = C.open === key;
      const li = h('li', { class: 'entry' }, h('button', { class: 'event-head', 'aria-expanded': String(open), onclick: () => set({ chrono: { ...C, open: open ? null : key } }) },
        h('time', { class: 'muted' }, clock(e.at)),
        h('span', { class: 'event-main' },
          h('span', { class: 'event-title' }, showFile ? [h('b', {}, base(e.file)), ' ', h('span', { class: 'muted' }, e.file.split('/').slice(0, -1).join('/'))] : (ACTION[e.action] || ACTION.edit)()),
          h('span', { class: 'muted' }, h('span', { class: 'agent ' + (e.who ? 'ai' : 'none') }), agentLabel(e.who), e.certainty === 'probable' ? ' (' + T`probable` + ')' : '', ' · ', (ACTION[e.action] || ACTION.edit)(), e.added || e.removed ? ` · +${e.added || 0} −${e.removed || 0}` : '', (e.newFindings || []).length ? ' · ' + plural(e.newFindings.length, T`aviso nuevo`, T`avisos nuevos`) : '')),
        h('span', { class: 'muted small' }, (SOURCE[e.source] || (() => ''))())));
      if (open) {
        const det = h('div', { class: 'detail' });
        if (e.commit) det.append(h('p', { class: 'muted' }, T`Commit ${e.commit}: ${e.message || ''}`));
        if (e.command) det.append(h('p', { class: 'muted' }, T`Es probable que lo cambiara esta orden de terminal, lanzada justo antes y que nombra el archivo:`), h('pre', { class: 'mono' }, e.command));
        if (e.before || e.after) {
          const cut = (txt) => { const ls = String(txt || '').split('\n'); const max = pro ? 200 : 30; return ls.length > max ? ls.slice(0, max).concat(T`… y ${ls.length - max} líneas más`) : ls; };
          det.append(h('h4', {}, T`Qué cambió`), h('pre', { class: 'diff' },
            e.before ? cut(e.before).map((l) => h('span', { class: 'del' }, '- ' + l + '\n')) : null,
            e.after ? cut(e.after).map((l) => h('span', { class: 'add' }, '+ ' + l + '\n')) : null));
        } else if (e.who == null) det.append(h('p', { class: 'muted' }, T`Spectator vio el cambio, pero ninguna IA lo registró: puede ser tuyo o de una herramienta que no deja registro.`));
        if ((e.newFindings || []).length) det.append(h('h4', {}, T`Avisos que aparecieron con este cambio`), h('ul', { class: 'plain' }, e.newFindings.map((x) => h('li', {}, h('span', { class: 'dot ' + x.severity }), ' ', h('button', { class: 'link', onclick: () => set({ tab: 'problemas', open: x.id, sev: null, cat: '', q: '' }) }, x.title)))));
        const comp = backendFiles.get(e.file);
        det.append(h('div', { class: 'actions' },
          e.action !== 'delete' ? h('button', { class: 'btn small primary', onclick: () => openFile(e.file, 1) }, T`Abrir`) : null,
          h('button', { class: 'btn small', onclick: () => post({ type: 'diffHead', file: e.file }) }, T`Comparar con el último commit`),
          comp ? h('button', { class: 'btn small', onclick: () => set({ tab: 'backend' }) }, T`Ver en el mapa del backend (${comp.roleName})`) : null));
        li.append(det);
      }
      return li;
    };
    if (C.by === 'file') {
      const groups = new Map();
      for (const e of list) (groups.get(e.file) || groups.set(e.file, []).get(e.file)).push(e);
      const box = h('div', { class: 'list' });
      let i = 0;
      for (const [file, es] of groups) {
        const who = [...new Set(es.map((e) => agentLabel(e.who)))].join(', ');
        box.append(h('div', { class: 'item' },
          h('div', { class: 'file-head' }, h('b', {}, base(file)), ' ', h('span', { class: 'muted' }, file.split('/').slice(0, -1).join('/')), h('span', { class: 'muted small' }, ' · ' + plural(es.length, T`cambio`, T`cambios`) + ' · ' + who)),
          h('ol', { class: 'timeline compact' }, es.map((e) => entryRow(e, i++, false)))));
      }
      p.append(box);
    } else p.append(h('ol', { class: 'timeline' }, list.map((e, i) => entryRow(e, i, true))));
    view.append(p);
  }

  // ───────────────────────── Problemas
  function itemRow(f, onclick, open) {
    return h('button', { class: 'head', 'aria-expanded': open == null ? null : String(open), onclick },
      h('span', { class: 'dot ' + f.severity, title: SEV[f.severity] }),
      h('span', { class: 'title' }, f.title, f.isNew ? [' ', h('span', { class: 'badge' }, T`nuevo`)] : null,
        S.mode === 'eng' ? h('div', { class: 'muted mono' }, f.tech) : null),
      h('span', { class: 'where mono' }, f.scope === 'project' ? T`todo el proyecto` : `${base(f.file)}:${f.line}`));
  }
  function detail(f) {
    const eng = S.mode === 'eng';
    const certainty = f.severity === 'human' ? T` · una máquina no puede decidir esto` : f.severity === 'fail' ? (f.category === 'security' && !f.rule.startsWith('secret') ? T` · el patrón está demostrado; el impacto depende de dónde vengan los datos` : T` · demostrado, no es una opinión`) : T` · medido; decide si aplica a tu caso`;
    const dl = h('dl', {},
      h('dt', {}, T`Por qué importa`), h('dd', {}, f.why),
      h('dt', {}, T`Qué hacer`), h('dd', {}, f.action));
    if (f.scope !== 'project') dl.append(h('dt', {}, T`Dónde`), h('dd', { class: 'mono' }, `${f.file}:${f.line}`));
    // La evidencia sigue a un clic: primero la respuesta sencilla, después el porqué técnico.
    if (eng) dl.append(h('dt', {}, T`Cómo lo sé`), h('dd', {}, h('ul', {}, f.evidence.map((e) => h('li', {}, e)))),
      h('dt', {}, T`Certeza`), h('dd', {}, h('span', { class: 'conf' }, h('i', { style: `width:${f.confidence}%` })), f.confidence + ' %', h('span', { class: 'muted' }, certainty)));
    if (eng) dl.append(h('dt', {}, T`Técnico`), h('dd', { class: 'mono' }, `${f.category}/${f.rule} · ${f.source} · ${f.fingerprint}`, h('div', {}, f.tech)));
    const el = h('div', { class: 'detail' }, dl);
    if (!eng) el.append(h('details', { class: 'fold' }, h('summary', {}, T`¿Cómo lo sé?`), h('ul', {}, f.evidence.map((e) => h('li', {}, e))), h('p', { class: 'muted' }, certainty.replace(/^ · /, ''))));
    if (f.code && (eng || f.severity === 'fail')) el.append(h('pre', {}, f.code));
    el.append(h('div', { class: 'actions host-only' },
      f.scope === 'project' ? null : h('button', { class: 'btn primary small', onclick: () => openFile(f.file, f.line) }, T`Abrir en el código`),
      (f.related || []).slice(0, 3).map((r) => h('button', { class: 'btn small', onclick: () => openFile(r.file, r.line) }, T`Ver ${base(r.file)}`)),
      f.rule === 'no-contract' ? h('button', { class: 'btn small', onclick: () => set({ tab: 'statements' }) }, T`Ir a Reglas`) : null,
      f.rule === 'incomplete-analysis' && outOfReach().length ? h('button', { class: 'btn small', title: T`Añade estos archivos a «exclude» en spectator.json: dejan de contar como análisis incompleto`, onclick: () => post({ type: 'exclude', files: outOfReach() }) }, T`Dejar fuera ${outOfReach().length} archivos generados o demasiado grandes`) : null,
      h('button', { class: 'btn small', title: T`No volver a mostrar este aviso (se guarda en spectator.json)`, onclick: () => post({ type: 'ignore', fingerprint: f.fingerprint }) }, f.severity === 'human' ? T`Ya está decidido` : T`No mostrar más`)));
    return el;
  }
  /** Archivos que no se analizan por decisión del motor (minificados, enormes, binarios): excluirlos es una decisión tuya. */
  const outOfReach = () => ((S.data.stats || {}).skipped || []).filter((s) => ['minified', 'size-limit', 'binary'].includes(s.reason)).map((s) => s.file);
  function findingList(list, emptyTitle, emptyText) {
    if (!list.length) return h('div', { class: 'list' }, h('div', { class: 'empty' }, h('b', {}, emptyTitle), emptyText));
    const box = h('div', { class: 'list' }, list.slice(0, S.shown).map((f) => {
      const open = S.open === f.id;
      return h('div', { class: 'item', id: 'f-' + f.id }, itemRow(f, () => set({ open: open ? null : f.id }), open), open ? detail(f) : null);
    }));
    if (list.length > S.shown) box.append(h('div', { class: 'item' }, h('button', { class: 'head', onclick: () => set({ shown: S.shown + 150 }) }, T`Mostrar más (${list.length - S.shown} restantes)`)));
    return box;
  }
  function viewProblemas(view) {
    const allP = findings();
    const eng = S.mode === 'eng';
    const q = S.q.trim().toLowerCase();
    const list = allP.filter((f) => (!S.sev || f.severity === S.sev) && (!S.cat || f.category === S.cat)
      && (!q || (f.title + ' ' + f.file + ' ' + f.tech).toLowerCase().includes(q)));
    const p = h('div', { class: 'pad' });
    const search = h('input', { type: 'search', placeholder: T`Buscar…`, value: S.q, 'aria-label': T`Buscar problemas`, style: 'flex:1;min-width:120px' });
    search.addEventListener('input', () => { S.q = search.value; S.shown = 150; const pos = search.selectionStart; render(); const n = root.querySelector('input[type=search]'); n.focus(); n.setSelectionRange(pos, pos); });
    const sel = eng ? h('select', { 'aria-label': T`Área`, onchange: (e) => set({ cat: e.target.value, open: null }) },
      h('option', { value: '' }, T`Todas las áreas`), S.data.categories.map((c) => h('option', { value: c.id, selected: S.cat === c.id }, c.label))) : null;
    // Un filtro activo siempre se ve y se puede quitar, aunque los controles técnicos estén ocultos.
    const active = !eng && (S.sev || S.cat) ? h('button', { class: 'chip', 'aria-pressed': 'true', onclick: () => set({ sev: null, cat: '', open: null }) },
      (S.sev ? GROUP[S.sev] : (S.data.categories.find((c) => c.id === S.cat) || {}).label) + ' ✕') : null;
    p.append(h('div', { class: 'filters' },
      eng ? ['fail', 'human', 'risk'].map((k) => h('button', { class: 'chip', 'aria-pressed': String(S.sev === k), onclick: () => set({ sev: S.sev === k ? null : k, open: null }) },
        h('span', { class: 'dot ' + k }), `${allP.filter((f) => f.severity === k).length} ${SEVS[k]}`)) : null,
      active, sel, search,
      allP.some((f) => f.isNew) || S.onlyNew ? h('button', { class: 'chip', 'aria-pressed': String(S.onlyNew), onclick: () => set({ onlyNew: !S.onlyNew }) }, T`Solo nuevos`) : null));
    if (!list.length) p.append(findingList(list, allP.length ? T`Nada coincide con el filtro` : T`Sin problemas detectados`, allP.length ? T`Prueba a quitar algún filtro.` : T`No encontrar avisos no garantiza que todo esté correcto: solo cuenta lo que se analizó.`));
    for (const sev of ['fail', 'human', 'risk']) {
      const group = list.filter((f) => f.severity === sev);
      if (group.length) p.append(h('h2', {}, `${GROUP[sev]} · ${group.length}`), h('p', { class: 'group-help muted' }, GROUP_HELP[sev]), findingList(group));
    }
    view.append(p);
    if (S.open) { const el = document.getElementById('f-' + S.open); if (el && el.getBoundingClientRect().top > view.clientHeight) el.scrollIntoView({ block: 'center' }); }
  }
  const GROUP = { fail: T`Fallos demostrados`, human: T`Decisiones que solo tú puedes tomar`, risk: T`Riesgos a revisar` };
  const GROUP_HELP = {
    fail: T`El código, tal como está escrito, no puede funcionar bien. Empieza por aquí.`,
    human: T`Dependen de lo que quieras que haga tu proyecto. Nunca se inventa una respuesta.`,
    risk: T`No son errores seguros: decide si te afectan.`,
  };

  // ───────────────────────── Statements
  // Cada operador es una frase completa para que cada idioma pueda ordenar nombre y valor a su manera.
  const OPW = {
    '=': (n, v) => T`${n} es ${v}`, '==': (n, v) => T`${n} igual a ${v}`, '!=': (n, v) => T`${n} distinto de ${v}`,
    '>=': (n, v) => T`${n} como mínimo ${v}`, '<=': (n, v) => T`${n} como máximo ${v}`, '>': (n, v) => T`${n} mayor que ${v}`, '<': (n, v) => T`${n} menor que ${v}`,
  };
  function sentence(s) {
    const [a, b] = (OPW[s.op] || ((n, v) => `${n} ${s.op} ${v}`))(human(s.name), '\u0001').split('\u0001');
    return h('span', {}, a, h('b', {}, String(s.value)), b);
  }
  const STATUS = { ok: T`Confirmada`, conflict: T`No cumple`, inconsistent: T`Valores distintos`, unconfirmed: T`Sin confirmar` };
  const human = (name) => name.replace(/\.length$/, T` (longitud)`).replace(/[_.]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  function viewStatements(view) {
    const all = statements();
    const p = h('div', { class: 'pad' });
    p.append(h('p', { class: 'muted', style: 'margin-top:0' }, T`Valores que deciden cómo se comporta tu programa: límites, edades, tiempos. Confirma los correctos y te avisaré si alguien los cambia.`));
    if (!all.length) { p.append(h('div', { class: 'list' }, h('div', { class: 'empty' }, h('b', {}, T`No se encontraron normas`), T`No hay constantes ni comparaciones con valores fijos en el código analizado.`))); view.append(p); return; }
    p.append(h('div', { class: 'filters' }, Object.keys(STATUS).map((k) => {
      const n = all.filter((s) => s.status === k).length;
      return n ? h('button', { class: 'chip', 'aria-pressed': String(S.stmFilter === k), onclick: () => set({ stmFilter: S.stmFilter === k ? null : k }) }, h('span', { class: 'tag ' + k }, STATUS[k]), n) : null;
    })));
    const groups = new Map();
    for (const s of all) { if (S.stmFilter && s.status !== S.stmFilter) continue; (groups.get(s.group) || groups.set(s.group, []).get(s.group)).push(s); }
    for (const [g, list] of groups) {
      p.append(h('h2', {}, g));
      p.append(h('div', { class: 'list' }, list.map((s) => h('div', { class: 'item stm' },
        h('span', { class: 'tag ' + s.status }, STATUS[s.status]),
        h('div', { class: 'rule' },
          S.mode === 'eng' ? h('b', {}, `${s.name} ${s.op} ${s.value}`) : sentence(s),
          s.status === 'conflict' ? h('span', { class: 'fail' }, T`  ·  el proyecto pide ${s.expected}`) : null,
          h('div', { class: 'meta' }, h('span', { class: 'mono' }, `${s.file}:${s.line}`),
            S.mode === 'eng' && s.usedBy && s.usedBy.length ? T` · lo usa ${s.usedBy.slice(0, 4).join(', ')}${s.usedBy.length > 4 ? '…' : ''}` : '',
            S.mode === 'eng' ? ' · ' + (s.tests ? T`mencionada en ${plural(s.tests, T`prueba`, T`pruebas`)}` : T`ninguna prueba la menciona`) : ''),
          S.mode === 'eng' ? h('div', { class: 'meta mono' }, s.code) : null),
        h('div', { class: 'actions host-only' },
          s.status === 'unconfirmed' || s.status === 'inconsistent' ? h('button', { class: 'btn small primary', title: T`Guardar como norma del proyecto`, onclick: () => post({ type: 'confirm', statement: s }) }, T`Es correcto`) : null,
          s.status === 'conflict' ? h('button', { class: 'btn small', title: T`Actualizar la norma al valor que hay en el código`, onclick: () => post({ type: 'confirm', statement: s }) }, T`Aceptar este valor`) : null,
          h('button', { class: 'btn small', onclick: () => openFile(s.file, s.line) }, T`Abrir`))))));
    }
    view.append(p);
  }

  // ───────────────────────── Flow
  // Tres niveles sobre el mismo mapa: Partes (carpetas del alcance actual), Archivos y Funciones.
  // Doble clic baja un nivel; las migas de arriba suben.
  let flowCtl = null;
  function stopFlow() { if (flowCtl) { flowCtl.destroy(); flowCtl = null; } }
  function flowLevel() {
    const F = S.flow;
    if (F.focus != null) return 'func';
    if (F.level) return F.level;
    const kids = children(S.scope);
    return kids.dirs.length && statsFor(S.scope).files > 30 ? 'parts' : 'file';
  }
  function buildFlowGraph() {
    const g = S.data.graph, F = S.flow, M = model(), level = flowLevel();
    const rt = F.totals || (S.data.runtime && S.data.runtime.counts) || null;
    const fileRt = new Map();
    if (rt) for (const u of g.units) if (rt[u.id]) fileRt.set(u.f, (fileRt.get(u.f) || 0) + rt[u.id]);
    const OUT = 'x:out';
    const outNode = () => ({ key: OUT, kind: 'out', label: T`Resto del proyecto`, sub: T`fuera de «${scopeName()}»`, sev: null, count: 0, neutral: true });
    const changedSet = new Set(((S.data.changes && S.data.changes.files) || []).map((c) => c.rel));
    const fileNode = (i) => {
      const f = g.files[i];
      return { changed: changedSet.has(f.rel), key: 'f' + i, kind: 'file', idx: i, label: base(f.rel), sub: f.rel.split('/').slice(0, -1).join('/'), sev: M.fileSev.get(f.rel) || (S.onlyNew ? null : f.sev) || null, count: fileRt.get(i) || 0, neutral: !M.unitsOf.has(i) };
    };
    let nodes = [], edges = [], note = '';
    const cap = (list, max, deg, text) => {
      if (list.length <= max) return list;
      note = text(list.length);
      return list.sort((a, b) => (deg.get(b) || 0) - (deg.get(a) || 0)).slice(0, max);
    };
    const link = (pairs, keyOf) => {
      const weight = new Map();
      for (const [a, b] of pairs) {
        const ka = keyOf(a), kb = keyOf(b);
        if (!ka || !kb || ka === kb || (ka === OUT && kb === OUT)) continue;
        const k = ka + '\u0001' + kb;
        weight.set(k, (weight.get(k) || 0) + 1);
      }
      const list = [];
      for (const [k, w] of weight) {
        const e = k.split('\u0001'), back = weight.get(e[1] + '\u0001' + e[0]);
        if (back && e[0] > e[1]) continue; // A↔B se dibuja una vez, con punta en ambos extremos
        e.w = w + (back || 0); e.both = !!back;
        list.push(e);
      }
      return list;
    };

    if (level === 'parts') {
      const kids = children(S.scope);
      const owner = new Map();
      for (const i of kids.files) owner.set(i, 'f' + i);
      g.files.forEach((f, i) => { if (owner.has(i)) return; const d = kids.dirs.find((k) => f.rel.startsWith(k.path + '/')); owner.set(i, d ? 'd:' + d.path : S.scope ? OUT : null); });
      const dirRt = new Map();
      for (const [i, n] of fileRt) { const k = owner.get(i); if (k) dirRt.set(k, (dirRt.get(k) || 0) + n); }
      nodes = kids.dirs.filter((k) => k.st.files).map((k) => ({
        key: 'd:' + k.path, kind: 'dir', path: k.path, label: partName(k), tag: k.comp ? k.comp.kind : '',
        sub: T`${k.st.files} archivos · ${k.st.units} funciones`, st: k.st, sev: k.st.sev, count: dirRt.get('d:' + k.path) || 0,
      })).concat(kids.files.filter((i) => !g.files[i].test).map(fileNode));
      edges = link(g.fileEdges, (i) => owner.get(i));
    } else if (level === 'file') {
      const deg = new Map();
      for (const [a, b] of g.fileEdges) { deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1); }
      const mine = g.files.map((f, i) => i).filter((i) => inScope(g.files[i].rel));
      const prod = mine.filter((i) => !g.files[i].test);
      const ids = new Set(cap(prod.length ? prod : mine, 200, deg, (n) => T`Mostrando los 200 archivos más conectados de ${n}`));
      nodes = [...ids].map(fileNode);
      edges = link(g.fileEdges, (i) => (ids.has(i) ? 'f' + i : S.scope && !inScope(g.files[i].rel) ? OUT : null));
    } else {
      let ids;
      if (F.focus != null) {
        const mine = new Set(M.unitsOf.get(F.focus) || []);
        ids = new Set(mine);
        for (const [a, b] of g.callEdges) { if (mine.has(a)) ids.add(b); if (mine.has(b)) ids.add(a); }
      } else {
        const deg = new Map();
        for (const [a, b] of g.callEdges) { deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1); }
        const mine = [...deg.keys()].filter((i) => !g.files[g.units[i].f].test && inScope(g.files[g.units[i].f].rel));
        ids = new Set(cap(mine, 250, deg, (n) => T`Mostrando las 250 funciones más conectadas de ${n}. Haz doble clic en un archivo para ver las suyas.`));
      }
      nodes = [...ids].map((i) => {
        const u = g.units[i], list = M.byUnit.get(i) || [];
        return { key: 'u' + i, kind: 'func', idx: i, label: (u.cls ? u.cls + '.' : '') + u.name, sub: base(g.files[u.f].rel), sev: M.unitSev.get(i) || null, flow: list.some((x) => x.flow), count: rt ? rt[u.id] || 0 : 0, dim: F.focus != null && u.f !== F.focus };
      });
      edges = link(g.callEdges, (i) => (ids.has(i) ? 'u' + i : F.focus == null && S.scope && !inScope(g.files[g.units[i].f].rel) ? OUT : null));
    }
    if (F.problems) {
      const keep = new Set(nodes.filter((n) => n.sev).map((n) => n.key));
      nodes = nodes.filter((n) => keep.has(n.key));
      edges = edges.filter((e) => keep.has(e[0]) && keep.has(e[1]));
    }
    if (edges.some((e) => e[0] === OUT || e[1] === OUT)) nodes.push(outNode());
    else edges = edges.filter((e) => e[0] !== OUT && e[1] !== OUT);
    if (g.unresolvedCalls?.length && !S.scope) note = [note, T`${g.unresolvedCalls.length} llamadas sin resolver (incluye código externo)`].filter(Boolean).join(' · ');
    return { nodes, edges, note, level, hasRuntime: !!rt && Object.keys(rt).length > 0 };
  }

  /** Disposición por capas: quien llama a la izquierda, quien es llamado a la derecha. */
  function layout(nodes, edges, W, H) {
    const GX = 86, GY = 16;
    const by = new Map(nodes.map((n) => [n.key, n]));
    const out = new Map(nodes.map((n) => [n.key, []])), inn = new Map(nodes.map((n) => [n.key, []]));
    // Romper ciclos: una arista hacia un nodo que está en la pila del recorrido se trata como «de vuelta».
    const adj = new Map(nodes.map((n) => [n.key, []]));
    for (const e of edges) adj.get(e[0]).push(e);
    const state = new Map();
    for (const n of nodes) {
      if (state.has(n.key)) continue;
      const stack = [[n.key, 0]]; state.set(n.key, 1);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const list = adj.get(top[0]);
        if (top[1] < list.length) {
          const e = list[top[1]++];
          const st = state.get(e[1]);
          if (st === 1) e.back = true;
          else if (!st) { state.set(e[1], 1); stack.push([e[1], 0]); }
        } else { state.set(top[0], 2); stack.pop(); }
      }
    }
    for (const e of edges) { if (e.back) continue; out.get(e[0]).push(e[1]); inn.get(e[1]).push(e[0]); }
    const layer = new Map(), indeg = new Map(nodes.map((n) => [n.key, inn.get(n.key).length]));
    const queue = nodes.filter((n) => !indeg.get(n.key)).map((n) => n.key);
    for (const k of queue) layer.set(k, 0);
    for (let i = 0; i < queue.length; i++) {
      const k = queue[i];
      for (const t of out.get(k)) { layer.set(t, Math.max(layer.get(t) || 0, layer.get(k) + 1)); indeg.set(t, indeg.get(t) - 1); if (!indeg.get(t)) queue.push(t); }
    }
    // Camino más largo da una fila interminable cuando casi todo depende de casi todo (típico entre archivos de un
    // mismo módulo). En ese caso se usa la distancia más corta desde los puntos de entrada: menos columnas, más llenas.
    const depth = Math.max(0, ...layer.values()) + 1;
    if (depth > 6 && nodes.length / depth < 3) {
      const seen = new Set(nodes.filter((n) => !inn.get(n.key).length).map((n) => n.key));
      let frontier = [...seen];
      for (const k of frontier) layer.set(k, 0);
      for (let d = 1; frontier.length; d++) {
        const next = [];
        for (const k of frontier) for (const t of out.get(k)) if (!seen.has(t)) { seen.add(t); layer.set(t, d); next.push(t); }
        frontier = next;
      }
    }
    const linked = new Set(); for (const e of edges) { linked.add(e[0]); linked.add(e[1]); }
    let cols = [];
    const lonely = [];
    for (const n of nodes) { if (!linked.has(n.key)) { lonely.push(n); continue; } const l = layer.get(n.key) || 0; (cols[l] || (cols[l] = [])).push(n); }
    const pos = new Map();
    cols.forEach((col) => col && col.forEach((n, i) => pos.set(n.key, i)));
    for (let sweep = 0; sweep < 4; sweep++) {
      const order = sweep % 2 ? [...cols.keys()].reverse() : [...cols.keys()];
      for (const l of order) {
        const col = cols[l]; if (!col) continue;
        const nb = sweep % 2 ? out : inn;
        for (const n of col) { const ns = nb.get(n.key).filter((k) => pos.has(k)); n._b = ns.length ? ns.reduce((s, k) => s + pos.get(k), 0) / ns.length : pos.get(n.key); }
        col.sort((a, b) => a._b - b._b);
        col.forEach((n, i) => pos.set(n.key, i));
      }
    }
    // Una columna muy alta se parte en varias contiguas para que el mapa conserve una proporción legible.
    const MAX_ROWS = 9;
    cols = cols.filter(Boolean).flatMap((col) => { const parts = []; for (let i = 0; i < col.length; i += MAX_ROWS) parts.push(col.slice(i, i + MAX_ROWS)); return parts; });
    const maxRows = Math.max(1, ...cols.map((c) => (c ? c.length : 0)));
    cols.forEach((col, l) => col && col.forEach((n, i) => { n.x = l * (W + GX); n.y = (i + (maxRows - col.length) / 2) * (H + GY); n.w = W; n.h = H; }));
    const perRow = Math.max(3, Math.min(8, Math.max(cols.length, Math.ceil(Math.sqrt(lonely.length * 2)))));
    const y0 = cols.length ? maxRows * (H + GY) + 36 : 0;
    lonely.forEach((n, i) => { n.x = (i % perRow) * (W + 24); n.y = y0 + Math.floor(i / perRow) * (H + GY); n.w = W; n.h = H; n.lonely = true; });
    return { by, lonelyY: lonely.length && cols.length ? y0 : null };
  }

  function viewFlow(view) {
    const F = S.flow, g = S.data.graph, M = model();
    if (F.focus != null && !g.files[F.focus]) F.focus = null;
    const G = buildFlowGraph();
    const big = G.level === 'parts';
    const { by, lonelyY } = layout(G.nodes, G.edges, big ? 204 : 172, big ? 56 : 38);
    if (F.sel && !by.has(F.sel)) F.sel = null;
    const wrap = h('div', { class: 'flow' });
    const cmd = h('input', { type: 'text', value: F.command, 'aria-label': T`Comando para ejecutar`, placeholder: 'npm start' });
    cmd.addEventListener('input', () => { F.command = cmd.value; persist(); });
    const rt = S.data.runtime;
    // La ejecución guardada corresponde al código de entonces: si cambió (o no se sabe), se dice junto al dato.
    const rtAge = !rt || rt.freshness === 'current' ? '' : ' · ' + (rt.freshness === 'stale' ? T`desactualizada: el código cambió después de ejecutarla` : T`no se sabe si corresponde al código actual`);
    const rtTitle = rt ? [rt.command, ...(rt.changedFiles || [])].filter(Boolean).join('\n') : '';
    const go = (level) => { F.level = level; F.focus = null; F.sel = null; render(); };
    const hasParts = children(S.scope).dirs.length > 0;
    wrap.append(h('div', { class: 'flowbar' },
      h('div', { class: 'seg', role: 'group', 'aria-label': T`Nivel del mapa` },
        hasParts ? h('button', { 'aria-pressed': String(G.level === 'parts'), title: T`Las carpetas de esta parte, como bloques`, onclick: () => go('parts') }, T`Partes`) : null,
        h('button', { 'aria-pressed': String(G.level === 'file'), onclick: () => go('file') }, T`Archivos`),
        h('button', { 'aria-pressed': String(G.level === 'func'), onclick: () => go('func') }, T`Funciones`)),
      h('button', { class: 'chip', 'aria-pressed': String(F.problems), title: T`Oculta lo que no tiene avisos para ver solo dónde los hay`, onclick: () => { F.problems = !F.problems; F.sel = null; render(); } }, T`Solo con avisos`),
      h('div', { class: 'spacer' }),
      F.live ? h('span', { class: 'pill pass' }, h('span', { class: 'dot pass' }), T`En vivo`)
        : rt && !F.totals ? h('span', { class: rtAge ? 'stale' : 'muted', title: rtTitle }, T`Última ejecución: ${Object.keys(rt.counts).length} de ${g.units.length} funciones` + rtAge) : null,
      h('span', { class: 'host-only', style: 'display:inline-flex;gap:6px' }, cmd,
        F.live ? h('button', { class: 'btn', onclick: () => post({ type: 'stopTrace' }) }, T`Detener`)
          : h('button', { class: 'btn primary', title: T`Ejecuta el comando y muestra por dónde pasa el programa (Node.js)`, onclick: () => { F.totals = {}; F.output = ''; F.live = true; post({ type: 'trace', command: F.command }); render(); } }, T`▶ Ver en vivo`))));
    const canvas = h('canvas', { tabindex: '0', 'aria-label': T`Mapa de flujo. Arrastra para mover, rueda para acercar, doble clic para entrar en una parte o un archivo.` });
    const stage = h('div', { class: 'stage' }, canvas);
    if (!G.nodes.length) {
      stage.append(h('div', { class: 'empty', style: 'position:relative' },
        h('b', {}, F.problems ? T`Nada con avisos en este nivel` : G.level === 'func' ? T`No se detectaron llamadas entre funciones` : T`No hay archivos de código que mostrar`),
        F.problems ? T`Quita «Solo con avisos» para ver el mapa completo.` : T`Prueba con la vista de Archivos.`));
    }
    stage.append(h('div', { class: 'legend' },
      S.mode === 'eng' ? h('span', {}, h('i', {}), T`conexión estática`) : null, G.hasRuntime ? h('span', {}, T`Los contadores muestran funciones ejecutadas, no llamadas entre ellas.`) : null,
      h('span', {}, h('span', { class: 'dot fail' }), T`falla`), h('span', {}, h('span', { class: 'dot risk' }), T`riesgo`), h('span', {}, h('span', { class: 'dot human' }), T`decisión`), h('span', {}, h('span', { class: 'dot pass' }), T`sin avisos`),
      G.nodes.some((n) => n.changed) ? h('span', {}, h('span', { class: 'dot changed' }), T`lo estás cambiando`) : null,
      G.level === 'func' && S.mode === 'eng' ? h('span', {}, '〜 ', T`fluye mal`) : null,
      G.note && S.mode === 'eng' ? h('span', {}, G.note) : null));
    const zoomBy = (factor) => { touched = true; const k = Math.max(0.1, Math.min(3, view2.k * factor)); view2.x = cw / 2 - (cw / 2 - view2.x) * (k / view2.k); view2.y = ch / 2 - (ch / 2 - view2.y) * (k / view2.k); view2.k = k; schedule(); };
    stage.append(h('div', { class: 'zoom', role: 'group', 'aria-label': T`Zoom del mapa` },
      h('button', { class: 'btn small', 'aria-label': T`Alejar`, onclick: () => zoomBy(1 / 1.25) }, '−'),
      h('button', { class: 'btn small', 'aria-label': T`Acercar`, onclick: () => zoomBy(1.25) }, '+'),
      h('button', { class: 'btn small', title: T`Encajar todo el mapa en la pantalla`, onclick: () => { fit(true); schedule(); } }, T`Ver todo`)));
    const side = h('div', { class: 'side', hidden: true });
    stage.append(side);
    wrap.append(stage);
    if (F.output) wrap.append(h('div', { class: 'console', 'aria-label': T`Salida del programa` }, F.output.slice(-1500)));
    view.append(wrap);
    view.style.overflow = 'hidden';

    // ── Motor de dibujo
    const ctx = canvas.getContext('2d');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const css = getComputedStyle(document.body);
    const col = (n, fb) => (css.getPropertyValue(n).trim() || fb);
    const TH = { fg: col('--fg', '#222'), muted: col('--muted', '#777'), card: col('--card', '#fff'), border: col('--border', '#ddd'), accent: col('--accent', '#2563eb'), bg: col('--bg', '#fff'),
      fail: col('--red'), risk: col('--amber'), human: col('--purple'), pass: col('--green') };
    const fontUi = css.fontFamily || 'system-ui';
    const edges = G.edges.map((e) => ({ a: by.get(e[0]), b: by.get(e[1]), back: !!e.back, both: !!e.both, w: e.w || 1 }));
    const view2 = { x: 0, y: 0, k: 1 };
    let hover = null, raf = 0, dead = false, lastT = 0, dpr = 1, cw = 0, ch = 0, touched = false;
    const pulses = new Map();

    /** Por defecto nunca reduce tanto que no se pueda leer: si el mapa no cabe, empieza por el principio y se desplaza. */
    function fit(all) {
      if (!G.nodes.length) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of G.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
      const w = x1 - x0, hh = y1 - y0;
      const k = Math.max(all ? 0.1 : 0.6, Math.min(1.15, (cw - 48) / w, (ch - 84) / hh));
      view2.k = k;
      view2.x = w * k <= cw - 48 ? (cw - w * k) / 2 - x0 * k : 24 - x0 * k;
      view2.y = hh * k <= ch - 84 ? Math.max(20, (ch - 44 - hh * k) / 2) - y0 * k : 20 - y0 * k;
    }
    function resize() {
      const r = stage.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1; cw = r.width; ch = r.height;
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
      schedule();
    }
    function curve(e) {
      const a = e.a, b = e.b;
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
      if (a.x === b.x) { // misma columna: un corchete por la derecha
        const bow = 26 + Math.min(40, Math.abs(y2 - y1) * 0.12);
        return [x1, y1, x1 + bow, y1, x1 + bow, y2, x1, y2];
      }
      if (x2 < x1) { // conexión «de vuelta»: pasa por debajo, de base a base, en vez de cruzar el mapa
        const sx = a.x + a.w / 2, sy = a.y + a.h, ex = b.x + b.w / 2, ey = b.y + b.h, drop = Math.max(sy, ey) + 34 + Math.min(60, Math.abs(sx - ex) * 0.08);
        return [sx, sy, sx, drop, ex, drop, ex, ey];
      }
      const dx = Math.max(40, (x2 - x1) * 0.5);
      return [x1, y1, x1 + dx, y1, x2 - dx, y2, x2, y2];
    }
    function draw(now) {
      const dt = Math.min(60, now - lastT); lastT = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.translate(view2.x, view2.y); ctx.scale(view2.k, view2.k);
      const sel = F.sel ? by.get(F.sel) : null;
      const focusNode = hover || sel;
      let moving = false;
      if (lonelyY != null) { ctx.fillStyle = TH.muted; ctx.font = `11px ${fontUi}`; ctx.fillText(T`SIN CONEXIONES DETECTADAS`, 0, lonelyY - 12); }
      for (const e of edges) {
        const c = e.c || (e.c = curve(e));
        const near = focusNode && (e.a === focusNode || e.b === focusNode);
        ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.bezierCurveTo(c[2], c[3], c[4], c[5], c[6], c[7]);
        ctx.strokeStyle = near ? TH.accent : TH.muted;
        ctx.globalAlpha = near ? 0.95 : focusNode ? 0.1 : 0.32;
        // El grosor indica cuántas conexiones estáticas resume la línea (solo en vistas agrupadas).
        ctx.lineWidth = Math.min(4, 1.1 + Math.log2(e.w) * 0.55);
        ctx.setLineDash(e.back ? [2, 3] : []);
        ctx.stroke(); ctx.setLineDash([]);
        // Punta de flecha: indica quién usa a quién (en ambos extremos si se usan mutuamente).
        ctx.fillStyle = ctx.strokeStyle;
        for (const [px, py, qx, qy] of e.both ? [[c[4], c[5], c[6], c[7]], [c[2], c[3], c[0], c[1]]] : [[c[4], c[5], c[6], c[7]]]) {
          const ang = Math.atan2(qy - py, qx - px), s = 6;
          ctx.beginPath(); ctx.moveTo(qx, qy);
          ctx.lineTo(qx - s * Math.cos(ang - 0.45), qy - s * Math.sin(ang - 0.45)); ctx.lineTo(qx - s * Math.cos(ang + 0.45), qy - s * Math.sin(ang + 0.45));
          ctx.closePath(); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      const small = view2.k < 0.45;
      for (const n of G.nodes) {
        const off = G.hasRuntime && !n.count && !n.neutral;
        const pulse = pulses.get(n.key) || 0;
        const outside = n.kind === 'out';
        ctx.globalAlpha = (n.dim ? 0.55 : 1) * (off ? 0.5 : 1);
        ctx.beginPath(); ctx.roundRect(n.x, n.y, n.w, n.h, 7);
        ctx.fillStyle = outside ? TH.bg : TH.card; ctx.fill();
        if (pulse > 0) { ctx.save(); ctx.globalAlpha = pulse * 0.35; ctx.fillStyle = TH.accent; ctx.fill(); ctx.restore(); pulses.set(n.key, pulse - dt / 700); moving = true; }
        ctx.lineWidth = n === sel || n === hover ? 2 : 1;
        ctx.strokeStyle = n === sel || n === hover || pulse > 0 ? TH.accent : TH.border;
        ctx.setLineDash(off || outside ? [4, 3] : []); ctx.stroke(); ctx.setLineDash([]);
        if (!outside) {
          ctx.fillStyle = TH[n.sev || 'pass'];
          ctx.beginPath(); ctx.roundRect(n.x, n.y, 5, n.h, [7, 0, 0, 7]); ctx.fill();
        }
        if (small) continue;
        ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
        const badge = n.count ? '×' + (n.count > 9999 ? Math.round(n.count / 1000) + 'k' : n.count) : '';
        ctx.font = `600 11px ${fontUi}`;
        const bw = badge ? ctx.measureText(badge).width + 10 : 0;
        const tw = n.tag ? ctx.measureText(n.tag).width + 8 : 0;
        const rows = n.kind === 'dir' ? 3 : n.sub ? 2 : 1;
        const top = n.y + (n.h - (rows - 1) * 14) / 2;
        ctx.fillStyle = TH.fg; ctx.font = `600 12px ${fontUi}`;
        ctx.fillText(clip(n.label, n.w - 22 - Math.max(bw, tw) - (n.flow ? 16 : 0)), n.x + 13, top);
        if (n.sub) { ctx.fillStyle = TH.muted; ctx.font = `10.5px ${fontUi}`; ctx.fillText(clip(n.sub, n.w - 22 - bw), n.x + 13, top + 14); }
        if (n.kind === 'dir') {
          // Tercera línea: cuántos avisos de cada tipo hay dentro.
          let x = n.x + 13;
          ctx.font = `600 10.5px ${fontUi}`;
          for (const s of ['fail', 'risk', 'human']) {
            if (!n.st[s]) continue;
            ctx.fillStyle = TH[s]; ctx.beginPath(); ctx.roundRect(x, top + 25, 6, 6, 3); ctx.fill();
            ctx.fillText(String(n.st[s]), x + 9, top + 28); x += 15 + ctx.measureText(String(n.st[s])).width;
          }
          if (!n.st.sev) { ctx.fillStyle = TH.pass; ctx.fillText('✓', x, top + 28); }
          if (n.tag) { ctx.fillStyle = TH.muted; ctx.font = `10px ${fontUi}`; ctx.textAlign = 'right'; ctx.fillText(n.tag, n.x + n.w - 8, top); ctx.textAlign = 'left'; }
        }
        // Archivo que estás cambiando: un punto del color de acento en la esquina.
        if (n.changed) { ctx.fillStyle = TH.accent; ctx.beginPath(); ctx.arc(n.x + n.w - 6, n.y + 6, 3.5, 0, Math.PI * 2); ctx.fill(); }
        if (n.flow) { ctx.fillStyle = TH[n.sev || 'risk']; ctx.font = `600 12px ${fontUi}`; ctx.textAlign = 'right'; ctx.fillText('〜', n.x + n.w - 6 - bw, n.y + 12); ctx.textAlign = 'left'; }
        if (badge) { ctx.fillStyle = TH.accent; ctx.font = `600 11px ${fontUi}`; ctx.textAlign = 'right'; ctx.fillText(badge, n.x + n.w - 8, n.y + n.h / 2 + (n.kind === 'dir' ? 12 : 0)); ctx.textAlign = 'left'; }
      }
      ctx.globalAlpha = 1;
      return moving;
    }
    function clip(text, max) {
      if (ctx.measureText(text).width <= max) return text;
      let t = text; while (t.length > 3 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
      return t + '…';
    }
    function frame(now) { raf = 0; if (dead) return; if (draw(now)) schedule(); }
    function schedule() { if (!raf && !dead) raf = requestAnimationFrame(frame); }

    const toWorld = (ev) => { const r = canvas.getBoundingClientRect(); return [(ev.clientX - r.left - view2.x) / view2.k, (ev.clientY - r.top - view2.y) / view2.k]; };
    const hit = (ev) => { const [x, y] = toWorld(ev); for (let i = G.nodes.length - 1; i >= 0; i--) { const n = G.nodes[i]; if (x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h) return n; } return null; };
    /** Bajar un nivel: parte → su interior, archivo → sus funciones, función → el código. */
    function enter(n) {
      if (!n) return;
      if (n.kind === 'dir') setScope(n.path);
      else if (n.kind === 'out') setScope(S.scope.includes('/') ? S.scope.slice(0, S.scope.lastIndexOf('/')) : '');
      else if (n.kind === 'file') { F.focus = n.idx; F.sel = null; render(); }
      else openFile(g.files[g.units[n.idx].f].rel, g.units[n.idx].line);
    }
    function jump(i) {
      const u = g.units[i];
      if (!inScope(g.files[u.f].rel)) S.scope = '';
      F.focus = u.f; F.sel = 'u' + i; persist(); render();
    }
    let drag = null;
    canvas.addEventListener('pointerdown', (ev) => { drag = { x: ev.clientX, y: ev.clientY, vx: view2.x, vy: view2.y, moved: false }; canvas.setPointerCapture(ev.pointerId); canvas.classList.add('grabbing'); });
    canvas.addEventListener('pointermove', (ev) => {
      if (drag) { const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = touched = true; view2.x = drag.vx + dx; view2.y = drag.vy + dy; schedule(); return; }
      const n = hit(ev); if (n !== hover) { hover = n; canvas.style.cursor = n ? 'pointer' : ''; schedule(); }
    });
    canvas.addEventListener('pointerup', (ev) => { canvas.classList.remove('grabbing'); const d = drag; drag = null; if (d && !d.moved) select(hit(ev)); });
    canvas.addEventListener('pointerleave', () => { if (hover) { hover = null; schedule(); } });
    canvas.addEventListener('dblclick', (ev) => enter(hit(ev)));
    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const r = canvas.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
      touched = true;
      const k = Math.max(0.1, Math.min(3, view2.k * Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015))));
      view2.x = mx - (mx - view2.x) * (k / view2.k); view2.y = my - (my - view2.y) * (k / view2.k); view2.k = k; schedule();
    }, { passive: false });
    canvas.addEventListener('keydown', (ev) => {
      const step = 60;
      if (ev.key === 'ArrowLeft') view2.x += step; else if (ev.key === 'ArrowRight') view2.x -= step; else if (ev.key === 'ArrowUp') view2.y += step; else if (ev.key === 'ArrowDown') view2.y -= step;
      else if (ev.key === '+' || ev.key === '=') view2.k = Math.min(3, view2.k * 1.2); else if (ev.key === '-') view2.k = Math.max(0.1, view2.k / 1.2); else if (ev.key === '0') fit(true);
      else if (ev.key === 'Enter' && F.sel) { enter(by.get(F.sel)); return; } else return;
      ev.preventDefault(); schedule();
    });

    function select(n) { F.sel = n ? n.key : null; renderSide(); schedule(); }
    function renderSide() {
      const n = F.sel ? by.get(F.sel) : null;
      side.textContent = '';
      side.hidden = !n;
      if (!n) return;
      // Element.append convierte listas y null en texto: aquí se aplanan y se descartan los vacíos.
      const put = (...kids) => { for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) side.append(kid); };
      const line = (...kids) => h('div', { class: 'line' }, kids);
      const goFinding = (x) => set({ tab: 'problemas', sev: null, cat: '', q: '', open: x.id });
      const sections = (list, max) => grouped(list).map(([title, items]) => [h('h4', {}, title), items.slice(0, max).map((x) => line(h('span', { class: 'dot ' + x.severity }), h('button', { class: 'link grow', onclick: () => goFinding(x) }, x.title))),
        items.length > max ? h('div', { class: 'muted' }, T`y ${items.length - max} más`) : null]);
      put(h('button', { class: 'close', 'aria-label': T`Cerrar`, onclick: () => select(null) }, '✕'));
      const rtc = F.totals || (S.data.runtime && S.data.runtime.counts) || {};
      if (n.kind === 'out') {
        put(h('h3', {}, n.label), h('div', { class: 'muted' }, T`Todo lo que «${scopeName()}» usa, o que lo usa, desde fuera de esta parte.`),
          h('div', { class: 'actions', style: 'margin-top:8px' }, h('button', { class: 'btn small primary', onclick: () => enter(n) }, T`Subir un nivel`)));
      } else if (n.kind === 'dir') {
        const list = S.data.findings.filter((x) => (!S.onlyNew || x.isNew) && x.scope !== 'project' && (x.file === n.path || x.file.startsWith(n.path + '/')));
        put(h('h3', {}, n.label), h('div', { class: 'muted mono' }, n.path + '/'), h('div', { class: 'muted' }, [n.tag, n.sub].filter(Boolean).join(' · ') + (n.count ? T` · ejecutado ×${n.count}` : '')),
          h('div', { class: 'actions', style: 'margin-top:8px' },
            h('button', { class: 'btn small primary', onclick: () => enter(n) }, T`Entrar`),
            list.length ? h('button', { class: 'btn small', onclick: () => setScope(n.path, { tab: 'problemas', sev: null, cat: '', q: '' }) }, T`Ver sus avisos`) : null));
        put(list.length ? sections(list, 6) : h('h4', {}, T`Sin avisos en esta parte`));
        const uses = edges.filter((e) => e.a === n).map((e) => e.b), usedBy = edges.filter((e) => e.b === n).map((e) => e.a);
        const lst = (title, arr) => (arr.length ? [h('h4', {}, title), arr.slice(0, 12).map((x) => line(h('span', { class: 'dot ' + (x.sev || (x.kind === 'out' ? 'none' : 'pass')) }), h('button', { class: 'link grow', onclick: () => select(x) }, x.label)))] : null);
        put(lst(T`Usa a`, uses), lst(T`La usan`, usedBy));
      } else if (n.kind === 'file') {
        const f = g.files[n.idx];
        const fs = M.byFile.get(f.rel) || [];
        const us = M.unitsOf.get(n.idx) || [];
        put(h('h3', {}, n.label), h('div', { class: 'muted mono' }, f.rel), h('div', { class: 'muted' }, T`${f.lines} líneas · ${us.length} funciones` + (n.count ? T` · ejecutado ×${n.count}` : '')),
          h('div', { class: 'actions', style: 'margin-top:8px' }, h('button', { class: 'btn small primary host-only', onclick: () => openFile(f.rel, 1) }, T`Abrir`), us.length ? h('button', { class: 'btn small', onclick: () => enter(n) }, T`Ver sus funciones`) : null));
        put(fs.length ? sections(fs, 8) : h('h4', {}, T`Sin avisos en este archivo`));
        const st = S.data.statements.filter((s) => s.file === f.rel);
        if (st.length) put(h('h4', {}, T`Normas`), st.slice(0, 10).map((s) => line(h('span', { class: 'tag ' + s.status }, STATUS[s.status]), h('span', { class: 'grow mono' }, `${s.name} ${s.op} ${s.value}`))));
        if (us.length) put(h('h4', {}, T`Funciones`), us.slice(0, 30).map((i) => { const u = g.units[i]; return line(h('span', { class: 'dot ' + (M.unitSev.get(i) || 'pass') }), h('button', { class: 'link grow mono', onclick: () => jump(i) }, u.name), h('span', { class: 'muted' }, rtc[u.id] ? '×' + rtc[u.id] : S.mode === 'eng' ? 'cx ' + u.cx : '')); }));
        // Cada conexión dice por qué existe: un import escrito, una llamada a una función de ese archivo o solo el
        // uso de un tipo con ese nombre (lo más débil: puede ser una coincidencia de nombre).
        const KIND = { import: T`import`, call: T`llamada`, type: T`usa un tipo` };
        const kinds = g.fileEdgeKinds || [];
        const conn = (mine, other) => g.fileEdges.map((e, k) => [e, kinds[k]]).filter(([e]) => e[mine] === n.idx && e[other] !== n.idx);
        const flist = (title, arr, other) => (arr.length ? [h('h4', {}, title), arr.slice(0, 15).map(([e, kd]) => line(h('span', { class: 'dot ' + (M.fileSev.get(g.files[e[other]].rel) || 'pass') }),
          h('button', { class: 'link grow mono', onclick: () => { F.focus = e[other]; F.sel = null; render(); } }, base(g.files[e[other]].rel)),
          kd ? h('span', { class: 'muted', title: kd === 'type' ? T`Solo coincide el nombre de un tipo; no hay import ni llamada seguida` : '' }, KIND[kd]) : null)),
          arr.length > 15 ? h('div', { class: 'muted' }, T`y ${arr.length - 15} más`) : null] : null);
        put(flist(T`Usa a`, conn(0, 1), 1), flist(T`Lo usan`, conn(1, 0), 0));
      } else {
        const u = g.units[n.idx], f = g.files[u.f];
        const fs = M.byUnit.get(n.idx) || [];
        const callers = g.callEdges.filter((e) => e[1] === n.idx).map((e) => e[0]);
        const callees = g.callEdges.filter((e) => e[0] === n.idx).map((e) => e[1]);
        const loose = u.end == null ? 0 : (g.unresolvedCalls || []).filter((c) => (Array.isArray(c) ? c[0] === u.f : c.file === f.rel) && (Array.isArray(c) ? c[1] : c.line) >= u.line && (Array.isArray(c) ? c[1] : c.line) <= u.end).length;
        put(h('h3', {}, n.label + '()'), h('div', { class: 'muted mono' }, `${f.rel}:${u.line}`),
          h('div', { class: 'muted' }, G.hasRuntime ? (n.count ? (n.count === 1 ? T`Se ejecutó 1 vez` : T`Se ejecutó ${n.count} veces`) : T`No se ejecutó en la última ejecución`) : T`Aún no hay datos de ejecución`, S.mode === 'eng' ? T` · complejidad ${u.cx}` : ''),
          h('div', { class: 'actions host-only', style: 'margin-top:8px' }, h('button', { class: 'btn small primary', onclick: () => openFile(f.rel, u.line) }, T`Abrir`)));
        put(fs.length ? sections(fs, 8) : h('h4', {}, T`Sin avisos en esta función`));
        const lst = (title, arr) => (arr.length ? [h('h4', {}, title), arr.slice(0, 15).map((i) => { const x = g.units[i]; return line(h('span', { class: 'dot ' + (M.unitSev.get(i) || 'pass') }), h('button', { class: 'link grow mono', onclick: () => jump(i) }, x.name), h('span', { class: 'muted' }, base(g.files[x.f].rel))); })] : null);
        put(lst(T`Posibles llamadas entrantes`, callers), lst(T`Posibles llamadas salientes`, callees));
        if (!callers.length && !fs.some((x) => x.rule.startsWith('unused'))) put(h('div', { class: 'muted', style: 'margin-top:10px' }, T`No encontré quién la llama dentro del proyecto. Puede ser un punto de entrada o llamarse de una forma que no se puede seguir leyendo el código.`));
        if (loose) put(h('div', { class: 'muted', style: 'margin-top:10px' }, T`${loose} llamadas de esta función van a código externo o no se pudieron seguir.`));
      }
    }

    // Mientras no hayas movido el mapa, se vuelve a encuadrar cuando cambia el tamaño del panel.
    const ro = new ResizeObserver(() => { resize(); if (!touched) fit(false); });
    ro.observe(stage);
    renderSide();
    flowCtl = {
      destroy() { dead = true; cancelAnimationFrame(raf); ro.disconnect(); },
      /** Evento en vivo: {delta: {unitId: veces}}. Solo actualiza contadores: no afirma quién llamó a quién. */
      live(delta) {
        const cnt = new Map();
        for (const id in delta) {
          const i = M.unitIndex.get(id); if (i == null) continue;
          const u = g.units[i];
          let key = 'u' + i;
          if (G.level !== 'func') { key = 'f' + u.f; if (!by.has(key)) { const d = G.nodes.find((x) => x.kind === 'dir' && g.files[u.f].rel.startsWith(x.path + '/')); key = d ? d.key : null; } }
          if (key) cnt.set(key, (cnt.get(key) || 0) + delta[id]);
        }
        G.hasRuntime = true;
        for (const [key, value] of cnt) { const n = by.get(key); if (!n) continue; n.count += value; if (!reduce) pulses.set(key, 1); }
        schedule();
      },
    };
  }

  // ───────────────────────── Mensajes desde VS Code
  let activityTimer = 0, liveTimer = 0;
  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'data') {
      // Los índices de archivo cambian entre análisis: el archivo abierto en Flow se recupera por su ruta.
      const open = S.data && S.flow.focus != null && S.data.graph.files[S.flow.focus] ? S.data.graph.files[S.flow.focus].rel : null;
      S.data = m.data; S.busy = false;
      const at = open == null ? -1 : m.data.graph.files.findIndex((f) => f.rel === open);
      S.flow.focus = at < 0 ? null : at; S.flow.sel = null;
      if (!S.flow.live) S.flow.totals = null;
      render();
    }
    else if (m.type === 'busy') { S.busy = true; const t = root.querySelector('.top'); if (t) t.classList.add('busy'); }
    else if (m.type === 'idle') { S.busy = false; const t = root.querySelector('.top'); if (t) t.classList.remove('busy'); }
    else if (m.type === 'show') set({ tab: m.sub || (m.tab === 'decisiones' ? 'problemas' : m.tab === 'mapa' ? S.lastSub.mapa : m.tab) || S.tab, open: m.open || null, sev: null, cat: m.cat || '', q: '', scope: m.open ? '' : S.scope });
    else if (m.type === 'live') {
      S.live = m.state;
      if (!liveTimer && S.tab === 'vivo') liveTimer = setTimeout(() => { liveTimer = 0; if (S.tab === 'vivo') render(); }, 250);
    }
    else if (m.type === 'chronology') { S.chrono.data = m.data; if (S.tab === 'cronologia' || S.tab === 'resumen') render(); }
    else if (m.type === 'activityState') { Object.assign(S.act, { events: m.events || [], api: m.api || null, logs: m.logs || [], guess: m.guess || null }); render(); }
    else if (m.type === 'activity') {
      S.act.events.push(m.event);
      if (S.act.events.length > 300) S.act.events.splice(0, S.act.events.length - 300);
      // Muchas llamadas seguidas (una página que carga) se agrupan en un solo repintado.
      if (!activityTimer && (S.tab === 'actividad' || S.tab === 'resumen' || isFailure(m.event))) activityTimer = setTimeout(() => { activityTimer = 0; if (S.tab !== 'flow') render(); }, 250);
    }
    else if (m.type === 'trace') { S.flow.totals = m.totals; if (flowCtl && S.tab === 'flow') flowCtl.live(m.delta, m.totals); }
    else if (m.type === 'traceOutput') { S.flow.output = (S.flow.output + m.text).slice(-4000); const c = root.querySelector('.console'); if (c) { c.textContent = S.flow.output.slice(-1500); c.scrollTop = c.scrollHeight; } else if (S.tab === 'flow' && !root.querySelector('.side:not([hidden])')) render(); }
    else if (m.type === 'traceEnd') {
      // Termina siempre el estado «En vivo», también si la ejecución no llegó a iniciarse: así se puede reintentar.
      const error = m.error || (m.data && m.data.error);
      S.flow.live = false; S.flow.totals = null;
      if (error) S.flow.output = (S.flow.output + '\n' + T`No se pudo iniciar el comando: ${error}` + '\n').slice(-4000);
      else if (m.data && m.data.instrumentation === 'unavailable') S.flow.output = (S.flow.output + '\n' + T`El programa se ejecutó, pero no se pudo observar: no se sabe qué funciones usó.` + '\n').slice(-4000);
      else if (S.data && m.data) S.data.runtime = m.data;
      if (S.tab === 'flow') render();
    }
  });
  render();
  post({ type: 'ready' });
})();
