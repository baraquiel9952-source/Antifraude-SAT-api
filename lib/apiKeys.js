// Gestión de API keys en Redis. Antes, dar de alta un cliente significaba
// editar API_KEYS a mano en Render y esperar el redeploy — no escala.
// Con esto, crear/revocar una clave es una llamada a /api/admin/keys,
// efectiva al instante, sin tocar el dashboard ni redeployar.

const crypto = require('crypto');
const { obtenerCliente } = require('./store');

function generarClaveAleatoria(prefijo = 'sat') {
  return `${prefijo}_${crypto.randomBytes(16).toString('hex')}`;
}

async function crearApiKey({ nombreCliente, plan = 'free' }) {
  const cliente = obtenerCliente();
  if (!cliente) throw new Error('No se puede crear una API key sin REDIS_URL configurada.');
  const clave = generarClaveAleatoria();
  const registro = {
    nombre: nombreCliente || 'sin nombre',
    plan,
    creado: new Date().toISOString(),
    activa: true,
  };
  await cliente.set(`apikey:${clave}`, JSON.stringify(registro));
  await cliente.sadd('apikeys:indice', clave);
  return { clave, ...registro };
}

async function obtenerApiKey(clave) {
  const cliente = obtenerCliente();
  if (!cliente || !clave) return null;
  try {
    const raw = await cliente.get(`apikey:${clave}`);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

async function listarApiKeys() {
  const cliente = obtenerCliente();
  if (!cliente) return [];
  try {
    const claves = await cliente.smembers('apikeys:indice');
    const registros = await Promise.all(claves.map(async k => {
      const raw = await cliente.get(`apikey:${k}`);
      return raw ? { clave: k, ...JSON.parse(raw) } : null;
    }));
    return registros.filter(Boolean);
  } catch (e) {
    return [];
  }
}

async function revocarApiKey(clave) {
  const cliente = obtenerCliente();
  if (!cliente) throw new Error('No se puede revocar sin REDIS_URL configurada.');
  await cliente.del(`apikey:${clave}`);
  await cliente.srem('apikeys:indice', clave);
}

async function actualizarPlanApiKey(clave, plan) {
  const cliente = obtenerCliente();
  if (!cliente) return false;
  const raw = await cliente.get(`apikey:${clave}`);
  if (!raw) return false;
  const registro = JSON.parse(raw);
  registro.plan = plan;
  await cliente.set(`apikey:${clave}`, JSON.stringify(registro));
  return true;
}

module.exports = { crearApiKey, obtenerApiKey, listarApiKeys, revocarApiKey, actualizarPlanApiKey };
