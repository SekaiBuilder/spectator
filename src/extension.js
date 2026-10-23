'use strict';
// Extensión de VS Code: solo presenta. Toda la lógica vive en ./core y funciona también desde la CLI.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { EngineClient } = require('./core/client');
const { relativeInside } = require('./core/util');
const { startApiWatch, guessTarget } = require('./core/apiwatch');
const { watchLogs } = require('./core/logwatch');
const { aiEdits, chronology, startOfToday } = require('./core/provenance');
const { startLive: startLiveRun, detectLive } = require('./core/live');
const { t, setLocale, normalize, dictFor, LOCALES } = require('./core/i18n');

// Funciones, no constantes: el idioma puede cambiar mientras la extensión está activa.
const sevLabel = (k, n) => ({ fail: [t`falla`, t`fallas`], risk: [t`riesgo`, t`riesgos`], human: [t`decisión`, t`decisiones`] })[k][n === 1 ? 0 : 1];
const verdictText = (v) => ({ pass: t`Sin problemas detectados`, risk: t`Con riesgos`, fail: t`Con fallas`, human: t`Necesita tu decisión` })[v];
const ICON = { pass: ['pass-filled', 'charts.green'], risk: ['warning', 'charts.yellow'], fail: ['error', 'charts.red'], human: ['question', 'charts.purple'] };

function activate(context) {
  // Una sesión por carpeta del área de trabajo: motor, último análisis, actividad y cambios observados propios.
  // El panel, la barra de estado y la barra lateral muestran la carpeta activa; los avisos de cada carpeta se
  // conservan en el editor aunque se cambie de carpeta.
  const folders = () => (vscode.workspace.workspaceFolders || []).map((f) => ({ path: f.uri.fsPath, name: f.name || path.basename(f.uri.fsPath) }));
  const rootOf = (fsPath) => folders().map((f) => f.path).filter((p) => p === fsPath || relativeInside(p, fsPath)).sort((a, b) => b.length - a.length)[0] || null;
  const sessions = new Map();
  const sessionOf = (r) => { if (!sessions.has(r)) sessions.set(r, { engine: new EngineClient(r), result: null, observed: [], activity: [], stale: false }); return sessions.get(r); };
  let root = folders().length ? folders()[0].path : null;
  let engine = root ? sessionOf(root).engine : null;
  const folderName = (r) => (folders().find((f) => f.path === r) || { name: r ? path.basename(r) : '' }).name;
  const cfg = () => vscode.workspace.getConfiguration('spectator');
  const locale = () => { const l = cfg().get('language'); return LOCALES.includes(l) ? l : normalize(vscode.env.language); };
  setLocale(locale());
  const diagnostics = vscode.languages.createDiagnosticCollection('spectator');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'spectator.open';
  const treeChanged = new vscode.EventEmitter();
  let result = null, panel = null, scanning = false, tracer = null, timer = null;
  // Peticiones de análisis en espera (ver scan).
  const waiting = [];
  // Actividad reciente: cambios de archivos (de VS Code, IntelliJ u otras herramientas), llamadas a la API y errores de log.
  let activity = root ? sessionOf(root).activity : [];
  let api = null, apiInfo = null, logs = null, baseStatus = '';
  let pendingSave = false;
  // Cronología del día: cambios que Spectator ve mientras está abierto (los de IA salen de sus registros).
  let observed = root ? sessionOf(root).observed : [];
  // Modo en vivo: la aplicación arrancada por Spectator, su estado y los fallos demostrados al ejecutarla.
  let live = null, liveState = null, liveFindings = [], liveRestart = false, liveTimer = null;
  // Estado del panel: si cargó y si su código falló al pintar (se registra en la consola de la extensión).
  let webviewReady = false;
  const clientErrors = [];

  // ── Barra lateral: salud por área
  const tree = {
    onDidChangeTreeData: treeChanged.event,
    getTreeItem: (x) => x,
    getChildren() {
      if (!view()) return [];
      const result = view();
      const head = new vscode.TreeItem(verdictText(result.verdict));
      head.description = t`${result.stats.sourceFiles} archivos · +${result.delta.added} nuevos`;
      head.iconPath = new vscode.ThemeIcon(ICON[result.verdict][0], new vscode.ThemeColor(ICON[result.verdict][1]));
      head.command = { command: 'spectator.open', title: t`Abrir` };
      // Solo las áreas con avisos, de la más grave a la menos; las demás se resumen en una fila.
      const rank = (c) => (c.fail ? 0 : c.human ? 1 : 2);
      const flagged = result.categories.filter((c) => c.fail || c.risk || c.human).sort((a, b) => rank(a) - rank(b));
      const clean = result.categories.filter((c) => !(c.fail || c.risk || c.human));
      const cats = flagged.map((c) => {
        const sev = c.fail ? 'fail' : c.human ? 'human' : 'risk';
        const item = new vscode.TreeItem(c.label);
        item.description = ['fail', 'risk', 'human'].filter((k) => c[k]).map((k) => `${c[k]} ${sevLabel(k, c[k])}`).join(' · ') || t`sin avisos`;
        item.tooltip = c.desc;
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(ICON[sev][1]));
        item.command = { command: 'spectator.open', title: t`Ver`, arguments: [{ tab: 'problemas', cat: c.id }] };
        return item;
      });
      if (clean.length) {
        const item = new vscode.TreeItem(clean.length === 1 ? t`1 área sin avisos` : t`${clean.length} áreas sin avisos`);
        item.tooltip = clean.map((c) => c.label).join(' · ');
        item.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor(ICON.pass[1]));
        item.command = { command: 'spectator.open', title: t`Ver`, arguments: [{ tab: 'resumen' }] };
        cats.push(item);
      }
      const link = (label, icon, tab) => { const i = new vscode.TreeItem(label); i.iconPath = new vscode.ThemeIcon(icon); i.command = { command: 'spectator.open', title: label, arguments: [{ tab }] }; return i; };
      const scope = [];
      if (folders().length > 1) {
        const item = new vscode.TreeItem(t`Carpeta: ${folderName(root)}`);
        item.description = t`cambiar (${folders().length} carpetas)`;
        item.tooltip = t`Spectator analiza cada carpeta del área de trabajo por separado. Elige cuál ver.`;
        item.iconPath = new vscode.ThemeIcon('root-folder');
        item.command = { command: 'spectator.selectFolder', title: t`Cambiar de carpeta` };
        scope.push(item);
      }
      return [head, ...scope, ...cats, link(t`Mapa del código`, 'type-hierarchy-sub', 'flow'), link(t`Reglas del proyecto: ${result.statements.length}`, 'checklist', 'statements')];
    },
  };

  /** El resultado del análisis más los fallos demostrados en vivo, con los recuentos al día. */
  function view() {
    if (!result || !liveFindings.length) return result;
    const findings = [...liveFindings, ...result.findings];
    const counts = { fail: 0, risk: 0, human: 0 };
    const per = {};
    for (const f of findings) { counts[f.severity]++; (per[f.category] || (per[f.category] = { fail: 0, risk: 0, human: 0 }))[f.severity]++; }
    const verdict = counts.fail ? 'fail' : counts.human ? 'human' : counts.risk ? 'risk' : 'pass';
    return { ...result, findings, counts, verdict, categories: result.categories.map((c) => ({ ...c, ...(per[c.id] || { fail: 0, risk: 0, human: 0 }) })) };
  }

  function publish(prev, reason) {
    const result = view();
    treeChanged.fire();
    const c = result.counts;
    const many = folders().length > 1;
    result.host = { root: folderName(root), path: root, roots: folders().map((f) => ({ name: f.name, path: f.path, current: f.path === root, analyzed: !!(sessions.get(f.path) && (sessions.get(f.path).result || f.path === root)) })) };
    baseStatus = '$(shield) ' + (c.fail ? `${c.fail} ${sevLabel('fail', c.fail)}` : c.human ? `${c.human} ${sevLabel('human', c.human)}` : c.risk ? `${c.risk} ${sevLabel('risk', c.risk)}` : t`sin avisos`)
      + (many ? ` · ${folderName(root)}` : '');
    status.text = statusText();
    status.tooltip = `Spectator · ${verdictText(result.verdict)} · ${c.fail} ${t`fallas`}, ${c.risk} ${t`riesgos`}, ${c.human} ${t`decisiones`}`
      + (many ? '\n' + t`Carpeta: ${folderName(root)}` : '');
    status.backgroundColor = c.fail ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    status.show();

    // Solo se reemplazan los avisos de esta carpeta: los de las demás siguen subrayados en el editor.
    if (diagnostics.forEach && cfg().get('diagnostics')) { const stale = []; diagnostics.forEach((uri) => { if (relativeInside(root, uri.fsPath)) stale.push(uri); }); for (const u of stale) diagnostics.delete(u); }
    else diagnostics.clear();
    if (cfg().get('diagnostics')) {
      const byFile = new Map();
      for (const f of result.findings) {
        if (f.scope === 'project') continue;
        const sev = f.severity === 'fail' ? vscode.DiagnosticSeverity.Error : f.severity === 'risk' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
        const line = Math.max(0, f.line - 1);
        const d = new vscode.Diagnostic(new vscode.Range(line, 0, Math.max(line, (f.endLine || f.line) - 1), 200), `${f.title}. ${f.action}`, sev);
        d.source = 'Spectator'; d.code = f.rule;
        (byFile.get(f.file) || byFile.set(f.file, []).get(f.file)).push(d);
      }
      for (const [file, list] of byFile) diagnostics.set(vscode.Uri.file(path.join(root, file)), list);
    }
    if (panel) panel.webview.postMessage({ type: 'data', data: result });
    if (panel) setTimeout(postChronology, 0);

    // Los archivos que cambiaron desde el análisis anterior pasan a la actividad, vengan de donde vengan.
    const touched = prev && result.changes ? result.changes.files.filter((f) => f.sinceLastScan) : [];
    if (touched.length) {
      for (const f of touched) observed.push({ at: result.scannedAt, file: f.rel, kind: f.sinceLastScan, source: reason === 'save' ? 'vscode' : 'external', newFindings: (f.newFindings || []).map((x) => ({ id: x.id, title: x.title, severity: x.severity })) });
      if (observed.length > 2000) observed.splice(0, observed.length - 2000);
      pushActivity({
        type: 'files', id: 'f' + Date.now(), at: result.scannedAt, source: reason === 'save' ? 'vscode' : 'external',
        files: touched.map((f) => ({ rel: f.rel, kind: f.sinceLastScan, newFindings: f.newFindings || [], fixedFindings: (f.fixedFindings || []).length, dependentsCount: f.dependentsCount })),
      });
    }

    // «Tu último cambio introdujo N problemas»: solo al guardar desde VS Code, donde estás mirando.
    // Los cambios hechos desde otro editor aparecen en Actividad sin interrumpir.: se compara con el análisis anterior, no con el histórico.
    if (prev && reason === 'save') {
      const before = new Set(prev.findings.map((f) => f.fingerprint));
      const fresh = result.findings.filter((f) => !before.has(f.fingerprint));
      if (fresh.length) {
        const worst = fresh[0];
        vscode.window.showWarningMessage((fresh.length === 1 ? t`Spectator: tu último cambio introdujo 1 aviso nuevo.` : t`Spectator: tu último cambio introdujo ${fresh.length} avisos nuevos.`) + ' ' + worst.title, t`Ver`)
          .then((pick) => pick && openPanel({ tab: worst.severity === 'human' ? 'decisiones' : 'problemas', open: worst.id }));
      }
    }
  }

  function statusText() {
    const errors = activity.filter((e) => (e.type === 'api' && (e.error || e.status >= 500)) || e.type === 'log').length;
    return baseStatus + (api ? ` · $(radio-tower) ${errors ? t`${errors} errores de API` : t`API`}` : '');
  }
  function pushActivity(e) {
    activity.push(e);
    if (activity.length > 300) activity.splice(0, activity.length - 300);
    if (panel) panel.webview.postMessage({ type: 'activity', event: e });
    if (baseStatus) status.text = statusText();
  }
  function activityState() {
    return { type: 'activityState', events: activity, api: apiInfo, logs: logs ? logs.files.map((f) => relativeInside(root, f) || f) : [], guess: root ? guessTarget(root) : null };
  }
  const postActivity = () => { if (panel) panel.webview.postMessage(activityState()); if (baseStatus) status.text = statusText(); };
  /** Cronología de hoy: lo visto por Spectator más las ediciones registradas por asistentes de IA y commits de IA. */
  function postChronology() {
    if (!panel || !root) return;
    panel.webview.postMessage({ type: 'chronology', data: computeChronology() });
  }
  function computeChronology() {
    let data;
    try {
      const since = startOfToday();
      data = chronology({ observed: observed.filter((o) => Date.parse(o.at) >= since), ai: aiEdits(root, { since, logs: cfg().get('chronology.aiLogs') !== false }) });
      data.aiLogs = cfg().get('chronology.aiLogs') !== false;
    } catch (e) { data = { entries: [], agents: [], total: 0, error: String((e && e.message) || e) }; }
    return data;
  }
  /** Diferencia entre el último commit y el archivo actual, en el visor de VS Code. */
  async function diffWithHead(rel) {
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return;
    const abs = path.resolve(root, rel);
    if (!relativeInside(root, abs)) return;
    const { spawnSync } = require('child_process');
    const top = (spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).stdout || '').trim();
    const r = top ? spawnSync('git', ['show', 'HEAD:' + path.relative(top, abs).split(path.sep).join('/')], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }) : { status: 1 };
    if (r.status !== 0) { vscode.window.showInformationMessage(t`Spectator: «${rel}» no está en el último commit de Git; no hay versión anterior con la que comparar.`); return; }
    const tmp = path.join(require('os').tmpdir(), 'spectator-head-' + crypto.randomBytes(4).toString('hex') + '-' + path.basename(rel));
    fs.writeFileSync(tmp, r.stdout);
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(tmp), vscode.Uri.file(abs), t`${path.basename(rel)}: último commit ↔ ahora`);
  }
  const projectFiles = () => (result ? result.graph.files.map((f) => f.rel) : []);

  /** Vigía de API: un intermediario local que deja pasar cada llamada a tu servidor y explica sus respuestas. */
  async function watchApi(target) {
    if (!root) { vscode.window.showInformationMessage(t`Spectator: abre una carpeta para analizarla.`); return; }
    if (api) { openPanel({ tab: 'actividad' }); return; }
    if (typeof target !== 'string' || !target.trim()) {
      target = cfg().get('api.target') || await vscode.window.showInputBox({
        title: t`URL de tu servidor`, value: guessTarget(root).url,
        prompt: t`La dirección donde responde tu aplicación, por ejemplo la que arrancas en IntelliJ.`,
      });
    }
    if (!target) return;
    try {
      api = await startApiWatch({ target: target.trim(), port: cfg().get('api.port') ?? 8099, root, files: projectFiles, onEvent: pushActivity });
    } catch (e) {
      vscode.window.showErrorMessage(t`Spectator no pudo arrancar el vigía de API: ${e && e.message || e}`);
      return;
    }
    apiInfo = { url: api.url, target: api.target, since: new Date().toISOString() };
    postActivity();
    openPanel({ tab: 'actividad' });
    const copy = t`Copiar dirección`;
    vscode.window.showInformationMessage(t`Spectator vigila tu API. Llama a ${api.url} en lugar de ${api.target}.`, copy)
      .then((pick) => pick === copy && vscode.env.clipboard && vscode.env.clipboard.writeText(api.url));
  }
  async function stopApi() {
    if (!api) return;
    const a = api;
    api = null; apiInfo = null;
    await a.stop();
    postActivity();
  }
  /** Lee en vivo los logs elegidos; la lista se recuerda para esta carpeta. */
  function startLogs(files) {
    if (logs) logs.stop();
    logs = files.length ? watchLogs({ files, root, projectFiles, onEvent: pushActivity }) : null;
    if (context.workspaceState) context.workspaceState.update('spectator.logFiles', files);
    postActivity();
  }
  async function pickLogs() {
    if (!root || !vscode.window.showOpenDialog) return;
    const picked = await vscode.window.showOpenDialog({ canSelectMany: true, defaultUri: vscode.Uri.file(root), openLabel: t`Leer errores de este log`, filters: { Logs: ['log', 'txt', 'out'], '*': ['*'] } });
    if (!picked || !picked.length) return;
    startLogs([...new Set([...(logs ? logs.files : []), ...picked.map((u) => u.fsPath)])]);
    openPanel({ tab: 'actividad' });
  }

  /**
   * Pide un análisis. Mientras otro está en curso, las peticiones esperan sin perderse: un análisis normal (guardar,
   * analizar de nuevo) se une a cualquiera que ya esté esperando, porque todos lo cubren; un análisis profundo o un
   * nuevo punto de partida se conservan como peticiones propias. Cada solicitante recibe el resultado del análisis
   * que atendió su petición, o undefined si falló.
   */
  function scan(opts = {}, reason = 'manual') {
    if (!engine) { vscode.window.showInformationMessage(t`Spectator: abre una carpeta para analizarla.`); return Promise.resolve(); }
    const kind = opts.resetBaseline ? 'baseline' : opts.deep ? 'deep' : 'normal';
    let job = waiting.find((j) => j.root === root && (kind === 'normal' || j.kind === kind));
    if (!job) { job = { kind, opts, reasons: new Set(), resolvers: [], root, engine }; waiting.push(job); }
    job.reasons.add(reason);
    const done = new Promise((resolve) => job.resolvers.push(resolve));
    pump();
    return done;
  }
  async function pump() {
    if (scanning || !waiting.length) return;
    const job = waiting.shift();
    scanning = true;
    if (panel) panel.webview.postMessage({ type: 'busy' });
    const prev = job.root === root ? result : sessionOf(job.root).result;
    const quiet = [...job.reasons].every((r) => r === 'save' || r === 'external');
    let out;
    try {
      const run = () => job.engine.scan({ ...job.opts, maxFiles: cfg().get('maxFiles'), locale: locale() });
      out = quiet ? await run() : await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: job.opts.deep ? t`Spectator: análisis profundo…` : t`Spectator: analizando…` }, run);
      sessionOf(job.root).result = out;
      // Si mientras tanto se cambió de carpeta, el resultado se guarda en su sesión sin mostrarse.
      if (job.root === root) {
        result = out;
        publish(prev, job.reasons.has('save') ? 'save' : job.reasons.has('external') ? 'external' : 'manual');
      }
    } catch (e) {
      out = undefined;
      vscode.window.showErrorMessage(t`Spectator no pudo completar el análisis: ${e && e.message || e}`);
    } finally {
      scanning = false;
      if (panel) panel.webview.postMessage({ type: 'idle' });
      for (const resolve of job.resolvers) resolve(out);
      pump();
    }
  }

  function html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', f));
    const loc = locale();
    const boot = `window.__PG_MODE__=${JSON.stringify(cfg().get('mode') || 'simple')};window.__PG_LOCALE__=${JSON.stringify(loc)};window.__PG_L10N__=${JSON.stringify(dictFor(loc)).replace(/</g, '\\u003c')};`;
    return `<!doctype html><html lang="${loc}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${uri('app.css')}"><title>Spectator</title></head>
<body><div id="app"></div><script nonce="${nonce}">${boot}</script><script nonce="${nonce}" src="${uri('app.js')}"></script></body></html>`;
  }

  function openPanel(show) {
    if (panel) { panel.reveal(); if (show) panel.webview.postMessage({ type: 'show', ...show }); return; }
    panel = vscode.window.createWebviewPanel('spectator', 'Spectator', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    panel.webview.html = html(panel.webview);
    panel.onDidDispose(() => { panel = null; webviewReady = false; }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage(async (m) => {
      try {
        if (m.type === 'clientError') { clientErrors.push(String(m.message).slice(0, 500)); console.error('[Spectator panel]', m.message); return; }
        if (m.type === 'ready') {
          webviewReady = true;
          if (result) panel.webview.postMessage({ type: 'data', data: view() }); else scan();
          panel.webview.postMessage(activityState());
          postChronology();
          if (liveState) panel.webview.postMessage({ type: 'live', state: liveState });
          if (show) panel.webview.postMessage({ type: 'show', ...show });
        } else if (m.type === 'open') {
          // Solo archivos existentes dentro del proyecto. Se comprueba la ruta real: un enlace simbólico
          // o un «..» no pueden llevar a una carpeta hermana ni a ningún otro sitio.
          if (typeof m.file !== 'string' || !m.file || path.isAbsolute(m.file)) return;
          const file = path.resolve(root, m.file);
          try {
            if (!relativeInside(fs.realpathSync(root), fs.realpathSync(file)) || !fs.statSync(file).isFile()) return;
          } catch { return; }
          const line = Math.max(0, (m.line || 1) - 1);
          const doc = await vscode.workspace.openTextDocument(file);
          vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false, selection: new vscode.Range(line, 0, line, 0) });
        } else if (m.type === 'scan') scan();
        else if (m.type === 'deepScan') scan({ deep: true });
        else if (m.type === 'setBaseline') { if (await scan({ resetBaseline: true })) vscode.window.showInformationMessage(t`Spectator: punto de partida actualizado. A partir de ahora «nuevo» es lo que aparezca desde este momento.`); }
        else if (m.type === 'confirm') { await engine.confirmStatement(m.statement); scan(); }
        else if (m.type === 'ignore') { await engine.ignoreFinding(m.fingerprint); scan(); }
        else if (m.type === 'exclude') { await engine.excludeFiles(m.files); scan(); }
        else if (m.type === 'trace') startTrace(m.command);
        else if (m.type === 'stopTrace') tracer && tracer.stop();
        else if (m.type === 'watchApi') await watchApi(typeof m.target === 'string' ? m.target : undefined);
        else if (m.type === 'stopApi') await stopApi();
        else if (m.type === 'pickLogs') await pickLogs();
        else if (m.type === 'stopLogs') startLogs([]);
        else if (m.type === 'liveStart') await startLive();
        else if (m.type === 'liveStop') stopLive();
        else if (m.type === 'liveReprobe') live && live.reprobe();
        else if (m.type === 'selectRoot' && typeof m.path === 'string') await switchRoot(m.path);
        else if (m.type === 'chronology') postChronology();
        else if (m.type === 'diffHead') await diffWithHead(m.file);
        else if (m.type === 'clearActivity') { activity.length = 0; postActivity(); }
        else if (m.type === 'mode' && (m.mode === 'simple' || m.mode === 'pro')) await cfg().update('mode', m.mode, vscode.ConfigurationTarget ? vscode.ConfigurationTarget.Global : true);
      } catch (e) { vscode.window.showErrorMessage(t`Spectator no pudo completar el análisis: ${e && e.message || e}`); }
    }, null, context.subscriptions);
  }

  /** Arranca la aplicación (Spring Boot), la observa y sondea su API. Los fallos demostrados se suman a Problemas. */
  async function startLive(quiet) {
    if (!root) { vscode.window.showInformationMessage(t`Spectator: abre una carpeta para analizarla.`); return; }
    if (live && liveState && ['starting', 'running'].includes(liveState.status)) { openPanel({ tab: 'vivo' }); return; }
    if (!detectLive(root)) { vscode.window.showWarningMessage(t`Spectator: el modo en vivo sabe arrancar proyectos Spring Boot (pom.xml o build.gradle con spring-boot) y Node/Express (package.json con express).`); return; }
    if (!result) await scan();
    liveFindings = [];
    if (!quiet) openPanel({ tab: 'vivo' });
    live = startLiveRun({
      root, allowWrites: !!cfg().get('live.allowWrites'),
      onState: (s) => {
        liveState = s;
        if (panel) panel.webview.postMessage({ type: 'live', state: s });
        // Reinicio pedido al guardar: se arranca de nuevo cuando la ejecución anterior ya terminó.
        if (liveRestart && ['stopped', 'exited', 'failed'].includes(s.status)) { liveRestart = false; startLive(true); }
      },
      onFinding: (list) => { liveFindings = list; if (result) publish(null, 'live'); },
    });
  }
  function stopLive() {
    liveRestart = false;
    if (live) live.stop();
  }
  /** Con spectator.live.restartOnSave, guardar código o configuración reinicia la app y repite las pruebas. */
  function restartLive(rel) {
    if (!live || !liveState || !cfg().get('live.restartOnSave') || !/\.(java|kt|properties|ya?ml|sql|[cm]?[jt]s|json|env)$/.test(rel)) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      if (['starting', 'running'].includes(liveState.status)) { liveRestart = true; live.stop(); } else startLive(true);
    }, 800);
  }

  async function startTrace(command) {
    if (!engine) return;
    if (!command) command = await vscode.window.showInputBox({ title: t`Comando a ejecutar (Node.js)`, value: 'npm start', prompt: t`Spectator mostrará en vivo por qué funciones pasa el programa.` });
    if (!command) return;
    if (!result) await scan();
    if (tracer) tracer.stop();
    openPanel({ tab: 'flow' });
    const send = (msg) => panel && panel.webview.postMessage(msg);
    tracer = engine.trace(command, {
      onUpdate: ({ delta, totals }) => send({ type: 'trace', delta, totals }),
      onOutput: (text) => send({ type: 'traceOutput', text }),
      // Si la ejecución no llega a iniciarse (o su proceso desaparece) el panel deja de esperar y se puede reintentar.
      onError: (e) => {
        tracer = null;
        const error = String((e && e.message) || e);
        send({ type: 'traceEnd', error });
        vscode.window.showErrorMessage(t`Spectator no pudo iniciar el flujo en vivo: ${error}`);
      },
      onExit: (data) => {
        tracer = null;
        send({ type: 'traceEnd', data });
        if (data.error) { vscode.window.showErrorMessage(t`Spectator no pudo iniciar el flujo en vivo: ${data.error}`); return; }
        // Sin lecturas del inspector no se sabe qué se ejecutó: no se presenta como «ninguna función».
        if (data.instrumentation === 'unavailable') { vscode.window.showWarningMessage(t`Spectator: el programa se ejecutó, pero no se pudo observar. Solo funciona con programas Node.js que permitan abrir el inspector.`); return; }
        if (result) result.runtime = data;
        if (!Object.keys(data.counts).length) vscode.window.showWarningMessage(t`Spectator: el comando terminó sin ejecutar funciones del proyecto. El flujo en vivo de esta beta solo funciona con programas Node.js.`);
      },
    });
  }

  /**
   * Un cambio en un archivo del proyecto vuelve a analizar, agrupando los cambios seguidos en un solo análisis.
   * «save» viene de guardar en VS Code; «external», de otro editor (IntelliJ, Xcode…) o de una herramienta.
   */
  function changed(uri, source = 'external') {
    const owner = rootOf(uri.fsPath);
    // Un cambio en otra carpeta se apunta: se analizará al volver a ella.
    if (owner && owner !== root) { if (sessions.has(owner)) sessions.get(owner).stale = true; return; }
    const rel = engine && relativeInside(root, uri.fsPath);
    if (!rel || !cfg().get('scanOnSave') || rel.split(path.sep).some((part) => part === '.spectator' || part === 'node_modules' || part === '.git' || part === '.idea' || part === 'target' || part === 'build' || part === 'out')) return;
    if (source === 'save') { pendingSave = true; restartLive(rel); }
    clearTimeout(timer);
    timer = setTimeout(() => { const reason = pendingSave ? 'save' : 'external'; pendingSave = false; scan({}, reason); }, 700);
  }
  // Crear, borrar o renombrar archivos (también desde otras herramientas) cambia las dependencias, no solo guardar.
  function watchFiles(list = folders().map((f) => f.path)) {
    if (!vscode.workspace.createFileSystemWatcher || !vscode.RelativePattern) return [];
    const external = (uri) => changed(uri, 'external');
    return list.flatMap((dir) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '**/*'));
      return [watcher, watcher.onDidCreate(external), watcher.onDidDelete(external), watcher.onDidChange(external)];
    });
  }

  /**
   * Cambia la carpeta activa. Lo que vigila la carpeta anterior (API, logs, app en marcha, flujo) se detiene,
   * porque pertenece a ese proyecto. Si la carpeta nueva no tiene análisis o cambió mientras tanto, se analiza.
   */
  async function switchRoot(next) {
    if (!next || next === root || !folders().some((f) => f.path === next)) return false;
    if (api) await stopApi();
    if (logs) { logs.stop(); logs = null; }
    stopLive(); if (tracer) tracer.stop();
    if (root) sessionOf(root).result = result;
    root = next;
    const s = sessionOf(root);
    engine = s.engine; result = s.result; activity = s.activity; observed = s.observed;
    liveFindings = []; liveState = null;
    postActivity();
    if (result && !s.stale) publish(null, 'switch');
    else { s.stale = false; if (panel) panel.webview.postMessage({ type: 'busy' }); scan({}, 'startup'); }
    treeChanged.fire();
    return true;
  }
  async function selectFolder() {
    const list = folders();
    if (list.length < 2 || !vscode.window.showQuickPick) return;
    const pick = await vscode.window.showQuickPick(list.map((f) => ({ label: f.name, description: f.path === root ? t`activa` : '', detail: f.path, path: f.path })), { title: t`¿Qué carpeta quieres ver en Spectator?` });
    if (pick) await switchRoot(pick.path);
  }

  context.subscriptions.push(
    diagnostics, status, treeChanged,
    vscode.window.registerTreeDataProvider('spectator.health', tree),
    vscode.commands.registerCommand('spectator.open', (show) => openPanel(show && show.tab ? show : undefined)),
    vscode.commands.registerCommand('spectator.scan', () => scan()),
    vscode.commands.registerCommand('spectator.deepScan', () => scan({ deep: true })),
    vscode.commands.registerCommand('spectator.setBaseline', () => scan({ resetBaseline: true })),
    vscode.commands.registerCommand('spectator.trace', () => startTrace()),
    vscode.commands.registerCommand('spectator.stopTrace', () => { tracer && tracer.stop(); stopLive(); }),
    vscode.commands.registerCommand('spectator.live', () => startLive()),
    vscode.commands.registerCommand('spectator.stopLive', () => stopLive()),
    vscode.commands.registerCommand('spectator.watchApi', () => watchApi()),
    vscode.commands.registerCommand('spectator.stopApi', () => stopApi()),
    vscode.commands.registerCommand('spectator.watchLogs', () => pickLogs()),
    vscode.commands.registerCommand('spectator.activity', () => openPanel({ tab: 'actividad' })),
    vscode.commands.registerCommand('spectator.chronology', () => openPanel({ tab: 'actividad', sub: 'cronologia' })),
    vscode.commands.registerCommand('spectator.backend', () => openPanel({ tab: 'mapa', sub: 'backend' })),
    vscode.commands.registerCommand('spectator.selectFolder', () => selectFolder()),
    // Al abrir un archivo de otra carpeta, Spectator pasa a esa carpeta (se puede desactivar).
    ...(vscode.window.onDidChangeActiveTextEditor ? [vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!ed || !ed.document || cfg().get('followActiveFolder') === false) return;
      const owner = rootOf(ed.document.uri.fsPath);
      if (owner && owner !== root) switchRoot(owner);
    })] : []),
    ...(vscode.workspace.onDidChangeWorkspaceFolders ? [vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const f of e.removed || []) { const s = sessions.get(f.uri.fsPath); if (s) { s.engine.dispose(); sessions.delete(f.uri.fsPath); } }
      context.subscriptions.push(...watchFiles((e.added || []).map((f) => f.uri.fsPath)));
      if (!folders().some((f) => f.path === root)) { root = null; result = null; if (folders().length) switchRoot(folders()[0].path); }
      treeChanged.fire();
    })] : []),
    vscode.workspace.onDidSaveTextDocument((doc) => changed(doc.uri, 'save')),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('spectator.language')) {
        setLocale(locale());
        if (panel) panel.webview.html = html(panel.webview);
        scan();
      } else if (e.affectsConfiguration('spectator.maxFiles')) scan();
      // Activar o desactivar los subrayados se aplica en el momento, sin esperar a otro análisis.
      else if (e.affectsConfiguration('spectator.diagnostics') && result) publish(null, 'config');
    }),
    ...watchFiles(),
    { dispose: () => { clearTimeout(timer); clearTimeout(liveTimer); tracer && tracer.stop(); live && live.stop(); api && api.stop(); logs && logs.stop(); for (const s of sessions.values()) s.engine.dispose(); } },
  );
  if (engine) scan({}, 'startup');
  // Los logs elegidos en otra sesión se vuelven a leer: es pasivo, no ejecuta nada.
  const savedLogs = context.workspaceState ? (context.workspaceState.get('spectator.logFiles') || []).filter((f) => typeof f === 'string' && fs.existsSync(f)) : [];
  if (root && savedLogs.length) startLogs(savedLogs);
  // Acceso de solo lectura para las pruebas de integración que se ejecutan dentro de VS Code (test/vscode).
  return { _test: { result: () => result, activity: () => activity, api: () => apiInfo, startLogs, chronology: () => computeChronology(), switchRoot, root: () => root, panel: () => panel, webviewReady: () => webviewReady, clientErrors: () => clientErrors, show: (msg) => panel && panel.webview.postMessage({ type: 'show', ...msg }) } };
}

function deactivate() {}

module.exports = { activate, deactivate };
