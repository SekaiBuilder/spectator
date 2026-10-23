'use strict';
const fs = require('fs');
const path = require('path');
const { dictFor } = require('./core/i18n');

/** Informe HTML autónomo: la misma interfaz de la extensión con los datos incrustados. */
function buildReport(result) {
  const media = path.join(__dirname, '..', 'media');
  const css = fs.readFileSync(path.join(media, 'app.css'), 'utf8');
  const js = fs.readFileSync(path.join(media, 'app.js'), 'utf8');
  const data = JSON.stringify(result).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="${result.locale || 'es'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spectator · ${result.name.replace(/[<&]/g, '')}</title><style>${css}</style></head>
<body class="standalone"><div id="app"></div><script>window.__PG_LOCALE__=${JSON.stringify(result.locale || 'es')};window.__PG_L10N__=${JSON.stringify(dictFor(result.locale || 'es')).replace(/</g, '\\u003c')};window.__PG_DATA__=${data};</script><script>${js}</script></body></html>`;
}

module.exports = { buildReport };
