// Historial de análisis por API key — antes /api/uso solo contaba, no guardaba
// qué se había analizado. Útil para que un gestor busque "¿ya revisé este documento?".

const { obtenerCliente } = require('./store');
const MAX_HISTORIAL = 200;

async function guardarAnalisis(apiKey, resultado, nombreDocumento) {
  const cliente = obtenerCliente();
  if (!cliente || !apiKey) return;
  try {
    const entrada = JSON.stringify({
      fecha: new Date().toISOString(),
      nombre_documento: nombreDocumento || null,
      score: resultado.score,
      veredicto: resultado.veredicto,
      hash_documento: resultado.detalles_tecnicos.hash_documento,
      rfc: resultado.detalles_tecnicos.identificacion_fiscal?.rfc || null,
    });
    const clave = `historial:${apiKey}`;
    await cliente.lpush(clave, entrada);
    await cliente.ltrim(clave, 0, MAX_HISTORIAL - 1);
    await cliente.expire(clave, 60 * 60 * 24 * 180); // 180 días
  } catch (e) {
    // no bloquear el análisis si falla el guardado de historial
  }
}

async function obtenerHistorial(apiKey, limite = 50) {
  const cliente = obtenerCliente();
  if (!cliente || !apiKey) return [];
  try {
    const items = await cliente.lrange(`historial:${apiKey}`, 0, limite - 1);
    return items.map(i => JSON.parse(i));
  } catch (e) {
    return [];
  }
}

module.exports = { guardarAnalisis, obtenerHistorial };
