'use strict';
// Explica en lenguaje sencillo qué significa la respuesta de una API y qué conviene revisar.
// Un código 2xx o 3xx no es un error: también se explica, porque «200» o «304» suelen confundir.
const http = require('http');
const { t } = require('./i18n');

const level = (code) => (code >= 500 ? 'server' : code >= 400 ? 'client' : code >= 300 ? 'redirect' : code >= 200 ? 'ok' : 'info');

// Textos por código. Funciones: el idioma puede cambiar mientras la extensión está activa.
const BY_CODE = {
  200: () => [t`Funcionó`, t`El servidor recibió la petición y respondió correctamente.`, t`Si la pantalla no muestra lo esperado, el problema está en los datos devueltos o en cómo se muestran, no en la llamada.`],
  201: () => [t`Creado`, t`El servidor creó lo que se pidió.`, t`Nada que corregir en la llamada.`],
  204: () => [t`Funcionó, sin contenido`, t`El servidor hizo la operación y no devuelve datos.`, t`Si esperabas datos, este endpoint no los envía: revisa el controlador.`],
  301: () => [t`Movido de forma permanente`, t`La dirección cambió y el cliente debe usar la nueva (cabecera Location).`, t`Actualiza la URL que usa tu aplicación.`],
  302: () => [t`Redirección temporal`, t`El servidor manda al cliente a otra dirección, a menudo a la página de inicio de sesión.`, t`Si no esperabas una redirección, revisa si la sesión caducó o falta autenticación.`],
  304: () => [t`Sin cambios: se usa la copia guardada`, t`El navegador ya tenía la versión actual y la reutiliza. No es un error.`, t`Si no ves tus cambios recientes, recarga sin caché.`],
  400: () => [t`Petición incorrecta`, t`El servidor no entiende los datos enviados: falta un campo, el formato no es válido o un tipo no coincide.`, t`Compara el cuerpo y los parámetros enviados con lo que espera el endpoint.`],
  401: () => [t`No autenticado`, t`Falta identificarse, o el token o la sesión no son válidos o caducaron.`, t`Comprueba la cabecera Authorization, el token o la cookie de sesión.`],
  403: () => [t`Prohibido`, t`El servidor sabe quién eres, pero no tienes permiso para esto.`, t`Revisa los roles y permisos del usuario y la configuración de seguridad (CORS, CSRF).`],
  404: () => [t`No encontrado`, t`No hay nada en esa dirección: la ruta está mal escrita, falta el controlador o el recurso no existe.`, t`Compara la URL y el método con las rutas definidas en el servidor.`],
  405: () => [t`Método no permitido`, t`La ruta existe, pero no acepta este método (por ejemplo, POST en lugar de GET).`, t`Usa el método que define el controlador para esa ruta.`],
  409: () => [t`Conflicto`, t`La operación choca con el estado actual, por ejemplo un registro duplicado.`, t`Revisa si el dato ya existe o si otro proceso lo cambió.`],
  413: () => [t`Demasiado grande`, t`Lo enviado supera el tamaño máximo que acepta el servidor.`, t`Reduce el tamaño o aumenta el límite de subida del servidor.`],
  415: () => [t`Formato no admitido`, t`El servidor no acepta el tipo de contenido enviado.`, t`Comprueba la cabecera Content-Type (por ejemplo, application/json).`],
  422: () => [t`Datos no válidos`, t`El formato es correcto, pero los valores no pasan la validación.`, t`Lee el mensaje del servidor: suele indicar qué campo falla.`],
  429: () => [t`Demasiadas peticiones`, t`Se superó el número de llamadas permitido.`, t`Espera o reduce la frecuencia de las llamadas.`],
  500: () => [t`Error interno del servidor`, t`El código del servidor falló mientras atendía la petición: una excepción que nadie controló.`, t`Mira la traza o el log del servidor: indica el archivo y la línea donde falló.`],
  501: () => [t`No implementado`, t`El servidor no tiene implementada esta operación.`, t`Comprueba que el endpoint esté terminado.`],
  502: () => [t`Respuesta inválida de otro servidor`, t`Un intermediario recibió una respuesta inválida del servidor de la aplicación.`, t`Comprueba que la aplicación esté arrancada y responda.`],
  503: () => [t`Servicio no disponible`, t`El servidor está arrancando, sobrecargado o en mantenimiento.`, t`Espera a que termine de arrancar o revisa sus recursos.`],
  504: () => [t`Se agotó el tiempo de espera`, t`Un servidor tardó demasiado en responder.`, t`Busca operaciones lentas: consultas a la base de datos o servicios externos.`],
};
BY_CODE[308] = BY_CODE[301];
BY_CODE[307] = BY_CODE[302];
const BY_LEVEL = {
  info: () => [t`Información`, t`Respuesta intermedia del protocolo; no es un error.`, t`Nada que corregir.`],
  ok: () => [t`Correcto`, t`La petición se completó.`, t`Nada que corregir en la llamada.`],
  redirect: () => [t`Redirección`, t`El servidor manda a otra dirección.`, t`Comprueba que la redirección sea la esperada.`],
  client: () => [t`Error en la petición`, t`El servidor rechazó la petición por algo del lado del cliente: los datos, la ruta o los permisos.`, t`Revisa la URL, el método, los datos enviados y la autenticación.`],
  server: () => [t`Error del servidor`, t`El servidor falló al atender la petición.`, t`Mira el log o la traza del servidor.`],
};
const NETWORK = {
  ECONNREFUSED: () => [t`La aplicación no responde`, t`No hay nada escuchando en esa dirección: la aplicación no está arrancada o usa otro puerto.`, t`Arranca la aplicación (por ejemplo, desde IntelliJ) y comprueba el puerto.`],
  ECONNRESET: () => [t`La conexión se cortó`, t`El servidor cerró la conexión a mitad de la respuesta; suele deberse a un fallo grave o a un reinicio.`, t`Mira el log del servidor en ese momento.`],
  ETIMEDOUT: () => [t`Sin respuesta a tiempo`, t`El servidor no contestó dentro del tiempo de espera.`, t`Busca operaciones lentas o bloqueadas en el servidor.`],
  ENOTFOUND: () => [t`Dirección desconocida`, t`No se encuentra ningún servidor con ese nombre.`, t`Revisa la URL configurada.`],
};

/** @returns {{code, level, label, title, meaning, check}} */
function explainStatus(code) {
  const n = Number(code);
  const lvl = level(n);
  const [title, meaning, check] = (BY_CODE[n] || BY_LEVEL[lvl])();
  return { code: n, level: lvl, label: `${n} ${http.STATUS_CODES[n] || ''}`.trim(), title, meaning, check };
}

/** Explica un fallo de red (la petición no llegó a tener respuesta). */
function explainNetworkError(errno) {
  const pick = NETWORK[errno] || NETWORK[errno === 'ESOCKETTIMEDOUT' ? 'ETIMEDOUT' : ''] || (() => [t`Error de conexión`, t`La petición no llegó a tener respuesta.`, t`Comprueba que la aplicación esté arrancada y que la URL sea correcta.`]);
  const [title, meaning, check] = pick();
  return { code: null, level: 'network', label: errno || 'ERROR', title, meaning, check };
}

module.exports = { explainStatus, explainNetworkError, level };
