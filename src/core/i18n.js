'use strict';
// Idiomas: el español es el texto fuente; catalog.js aporta inglés y japonés.
// Uso: t`La función «${name}» …`  → la clave es el texto con {0}, {1}… en lugar de los valores.
//      N`texto`  marca un texto definido antes de conocer el idioma; se traduce después con tr().
const catalog = require('./catalog');

const LOCALES = ['es', 'en', 'ja'];
const dicts = { en: new Map(), ja: new Map() };
for (const [es, en, ja] of catalog) { dicts.en.set(es, en); dicts.ja.set(es, ja); }
let locale = 'es';

function normalize(l) {
  const s = String(l || '').toLowerCase();
  return s.startsWith('ja') ? 'ja' : s.startsWith('es') ? 'es' : 'en';
}
function setLocale(l) { locale = LOCALES.includes(l) ? l : normalize(l); return locale; }
const getLocale = () => locale;
const fill = (tpl, vals) => tpl.replace(/\{(\d+)\}/g, (m, i) => String(vals[i]));
const tr = (key) => (locale === 'es' ? key : dicts[locale].get(key) || key);
function t(strings, ...vals) {
  const key = strings.reduce((a, s, i) => a + '{' + (i - 1) + '}' + s);
  return vals.length ? fill(tr(key), vals) : tr(key);
}
const N = (strings) => strings[0];
/** Diccionario plano para la interfaz web (vacío en español). */
const dictFor = (l) => (l === 'es' ? {} : Object.fromEntries(dicts[l] || []));

module.exports = { t, tr, N, setLocale, getLocale, normalize, dictFor, LOCALES };
