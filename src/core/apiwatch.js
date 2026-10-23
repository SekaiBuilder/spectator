'use strict';
// Vigía de API: un intermediario local entre quien llama (navegador, Postman, la app móvil…) y tu servidor.
// Deja pasar cada petición sin cambiarla y registra método, ruta, código, duración y, si hay error,
// el mensaje del servidor y la traza relacionada con archivos del proyecto. Funciona con cualquier lenguaje:
// una app Spring arrancada desde IntelliJ, un servidor Node, Django, .NET…
//
// Privacidad: nunca se guardan cuerpos de petición ni cabeceras de autenticación o cookies. De las respuestas
// solo se guarda un fragmento acotado y enmascarado cuando son errores.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { explainStatus, explainNetworkError } = require('./http-status');
const { projectFrames, errorHeadline } = require('./stack');

const MAX_BODY = 64 * 1024;
const ASSET = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|txt|wasm)(?:\?|$)/i;

/** Oculta secretos frecuentes en un fragmento de texto: tokens, contraseñas y cabeceras de autorización. */
function mask(text) {
  return String(text)
    .replace(/("(?:[\w-]*(?:password|passwd|secret|token|apikey|api_key|authorization|cookie|session)[\w-]*)"\s*:\s*)"[^"]*"/gi, '$1"•••"')
    .replace(/\b(Bearer|Basic)\s+[\w\-.~+/=]{8,}/g, '$1 •••')
    .replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g, '•••');
}

/** Mensaje del servidor dentro del cuerpo de un error: JSON de Spring, Express, ASP.NET, RFC 7807, texto o HTML. */
function serverMessage(body, contentType) {
  if (!body) return { message: null, trace: '' };
  if (/json/i.test(contentType || '') || /^\s*[{[]/.test(body)) {
    try {
      const j = JSON.parse(body);
      const pick = (...keys) => keys.map((k) => j && j[k]).find((v) => typeof v === 'string' && v.trim());
      const trace = [j && j.trace, j && j.stack, j && j.stackTrace, j && j.exception].filter((v) => typeof v === 'string').join('\n');
      return { message: pick('message', 'detail', 'error_description', 'title', 'error', 'msg'), trace };
    } catch { /* no era JSON completo */ }
  }
  const text = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ');
  return { message: errorHeadline(text), trace: text };
}

/**
 * Arranca el vigía.
 * @param {object} o
 * @param {string} o.target   URL de tu servidor, p. ej. http://localhost:8080
 * @param {number} [o.port]   puerto local del vigía (0 = uno libre; si está ocupado se usa uno libre)
 * @param {string} [o.root]   carpeta del proyecto, para relacionar trazas con archivos
 * @param {() => string[]} [o.files] rutas relativas de los archivos del proyecto
 * @param {(event) => void} o.onEvent
 * @returns {Promise<{url: string, target: string, stop: () => Promise<void>}>}
 */
function startApiWatch({ target, port = 0, root = '', files = () => [], onEvent = () => {} }) {
  let up;
  try { up = new URL(target); } catch { return Promise.reject(new Error('invalid-target')); }
  if (!/^https?:$/.test(up.protocol)) return Promise.reject(new Error('invalid-target'));
  const agent = up.protocol === 'https:' ? https : http;
  let seq = 0;
  const base = up.pathname.replace(/\/$/, '');

  const emit = (e) => { try { onEvent(e); } catch { /* el receptor no debe tumbar el vigía */ } };
  const record = (req, start, status, contentType, body, error) => {
    const errored = error || status >= 400;
    const info = errored && body ? serverMessage(body, contentType) : { message: null, trace: '' };
    const frames = info.trace || body ? projectFrames(`${info.trace}\n${body || ''}`, files(), root) : [];
    emit({
      type: 'api', id: ++seq, at: new Date().toISOString(), method: req.method, path: req.url, status: status || null,
      ms: Date.now() - start, contentType: contentType || null, asset: ASSET.test(req.url) && !errored,
      message: info.message ? mask(info.message).slice(0, 500) : null,
      body: errored && body ? mask(body).slice(0, 2000) : null,
      frames, error: error || null,
      explanation: error ? explainNetworkError(error) : explainStatus(status),
    });
  };

  const server = http.createServer((req, res) => {
    const start = Date.now();
    const headers = { ...req.headers, host: up.host };
    // Sin reutilizar conexiones: si reinicias el servidor (por ejemplo, desde IntelliJ), una conexión vieja
    // daría «conexión cortada» en vez de la respuesta real.
    const upstream = agent.request({ protocol: up.protocol, hostname: up.hostname, port: up.port, method: req.method, path: base + req.url, headers, agent: false }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      const chunks = [];
      let size = 0;
      const keep = r.statusCode >= 400;
      r.on('data', (d) => { if (keep && size < MAX_BODY) { chunks.push(d); size += d.length; } });
      r.pipe(res);
      r.on('end', () => {
        let body = null;
        if (keep && chunks.length) {
          let buf = Buffer.concat(chunks);
          const enc = String(r.headers['content-encoding'] || '');
          try { if (/gzip/.test(enc)) buf = zlib.gunzipSync(buf); else if (/br/.test(enc)) buf = zlib.brotliDecompressSync(buf); else if (/deflate/.test(enc)) buf = zlib.inflateSync(buf); } catch { buf = null; }
          body = buf ? buf.toString('utf8') : null;
        }
        record(req, start, r.statusCode, r.headers['content-type'], body, null);
      });
    });
    upstream.on('error', (e) => {
      const code = e.code || 'ERROR';
      if (!res.headersSent) {
        const ex = explainNetworkError(code);
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Spectator: ${ex.title}. ${ex.meaning} ${ex.check} (${target})\n`);
      } else res.destroy();
      record(req, start, null, null, null, code);
    });
    req.pipe(upstream);
  });

  // WebSocket y otras actualizaciones de protocolo (recarga en caliente de Vite, etc.): se reenvían tal cual.
  server.on('upgrade', (req, socket, head) => {
    const upstream = agent.request({ protocol: up.protocol, hostname: up.hostname, port: up.port, method: req.method, path: base + req.url, headers: { ...req.headers, host: up.host } });
    upstream.on('upgrade', (r, upSocket, upHead) => {
      socket.write(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n` + Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (upHead && upHead.length) socket.write(upHead);
      if (head && head.length) upSocket.write(head);
      upSocket.pipe(socket).pipe(upSocket);
      upSocket.on('error', () => socket.destroy()); socket.on('error', () => upSocket.destroy());
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  });

  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const listen = (p) => new Promise((resolve, reject) => {
    const fail = (e) => { server.off('listening', ok); reject(e); };
    const ok = () => { server.off('error', fail); resolve(); };
    server.once('error', fail); server.once('listening', ok);
    server.listen(p, '127.0.0.1');
  });
  return listen(port).catch((e) => { if (e.code === 'EADDRINUSE' && port) return listen(0); throw e; }).then(() => ({
    url: `http://localhost:${server.address().port}`,
    port: server.address().port,
    target: up.origin + base,
    stop: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  }));
}

/**
 * Propone la URL del servidor leyendo la configuración del proyecto, sin ejecutar nada:
 * Spring (server.port), variables PORT de .env, scripts con --port y valores por defecto de Vite o Next.
 * @returns {{url: string, reason: string}}
 */
function guessTarget(root) {
  const read = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };
  for (const rel of ['src/main/resources/application.properties', 'src/main/resources/application.yml', 'src/main/resources/application.yaml']) {
    const s = read(rel);
    if (s == null) continue;
    const m = /server\.port\s*[=:]\s*(\d+)/.exec(s) || /server:\s*\n(?:\s+.*\n)*?\s+port:\s*(\d+)/.exec(s);
    return { url: `http://localhost:${m ? m[1] : 8080}`, reason: m ? `${rel}: server.port` : 'spring-default' };
  }
  const env = read('.env');
  const envPort = env && /^\s*PORT\s*=\s*(\d+)/m.exec(env);
  if (envPort) return { url: `http://localhost:${envPort[1]}`, reason: '.env: PORT' };
  const pkg = read('package.json');
  if (pkg) {
    const scripts = (() => { try { return JSON.parse(pkg).scripts || {}; } catch { return {}; } })();
    const all = Object.values(scripts).join(' ');
    const flag = /--port[ =](\d+)|-p (\d+)/.exec(all);
    if (flag) return { url: `http://localhost:${flag[1] || flag[2]}`, reason: 'package.json: --port' };
    if (/\bvite\b/.test(all)) return { url: 'http://localhost:5173', reason: 'vite-default' };
    if (/\bnext\b/.test(all)) return { url: 'http://localhost:3000', reason: 'next-default' };
    return { url: 'http://localhost:3000', reason: 'node-default' };
  }
  if (read('manage.py') != null) return { url: 'http://localhost:8000', reason: 'django-default' };
  const py = ['requirements.txt', 'pyproject.toml', 'Pipfile'].map(read).join('\n').toLowerCase();
  if (/\bfastapi\b|\buvicorn\b/.test(py)) return { url: 'http://localhost:8000', reason: 'fastapi-default' };
  if (/\bflask\b/.test(py)) return { url: 'http://localhost:5000', reason: 'flask-default' };
  return { url: 'http://localhost:8080', reason: 'default' };
}

module.exports = { startApiWatch, guessTarget, serverMessage, mask };
