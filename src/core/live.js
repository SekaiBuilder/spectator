'use strict';
// Modo en vivo: elige el adaptador según el proyecto. Cada adaptador arranca la aplicación, la sondea y publica
// el mismo estado ({status, port, endpoints, requests, findings, needs…}), así el panel y la CLI no cambian.
const { startSpringLive, detectProject } = require('./springrun');
const { startNodeLive, detectNode } = require('./noderun');

function detectLive(root) {
  return detectProject(root) || detectNode(root);
}

function startLive(opts) {
  return detectProject(opts.root) ? startSpringLive(opts) : startNodeLive(opts);
}

module.exports = { detectLive, startLive };
