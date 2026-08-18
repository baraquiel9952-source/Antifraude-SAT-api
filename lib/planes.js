// [PIEZA 2] Planes free/paid con límites de uso persistentes.
// Sin esto, el contador vivía en memoria y se borraba cada vez que Render
// reiniciaba el servicio — imposible de usar para cobrar de verdad.

const { obtenerCliente, estaDisponible } = require('./store');
const { obtenerApiKey, actualizarPlanApiKey } = require('./apiKeys');

// Defaults por plan — un cliente puede pisar esto con un límite personalizado
// desde el panel de admin (registro.limiteMensual), sin tocar este archivo.
const LIMITES = { free: 20, starter: 300, profesional: 2000, empresarial: 10000, pro: 100000 };
const PLAN_DEFAULT = 'free';

function mesActual() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function obtenerPlan(apiKey) {
  const cliente = obtenerCliente();
  if (!cliente || !apiKey) return PLAN_DEFAULT;
  try {
    // Prioridad 1: registro dinámico de la clave (creada vía /api/admin/keys)
    const registro = await obtenerApiKey(apiKey);
    if (registro && registro.plan) return registro.plan;
    // Prioridad 2: override manual legado (/api/admin/plan sobre una clave estática)
    const planLegacy = await cliente.get(`plan:${apiKey}`);
    return planLegacy || PLAN_DEFAULT;
  } catch (e) {
    return PLAN_DEFAULT;
  }
}

async function establecerPlan(apiKey, plan) {
  const cliente = obtenerCliente();
  if (!cliente) throw new Error('Almacén de planes no disponible — falta configurar REDIS_URL.');
  if (!LIMITES[plan]) throw new Error(`Plan "${plan}" no reconocido. Usa: ${Object.keys(LIMITES).join(', ')}.`);

  const actualizoRegistroDinamico = await actualizarPlanApiKey(apiKey, plan);
  if (!actualizoRegistroDinamico) {
    // Clave estática (definida en API_KEYS) sin registro propio en Redis — usa el override legado.
    await cliente.set(`plan:${apiKey}`, plan);
  }
}

async function incrementarUso(apiKey) {
  const cliente = obtenerCliente();
  if (!cliente || !apiKey) return null;
  try {
    const clave = `uso:${apiKey}:${mesActual()}`;
    const nuevo = await cliente.incr(clave);
    if (nuevo === 1) await cliente.expire(clave, 60 * 60 * 24 * 40); // 40 días, sobra margen sobre el mes
    return nuevo;
  } catch (e) {
    return null;
  }
}

async function obtenerUso(apiKey) {
  const cliente = obtenerCliente();
  if (!cliente || !apiKey) return 0;
  try {
    const valor = await cliente.get(`uso:${apiKey}:${mesActual()}`);
    return valor ? parseInt(valor, 10) : 0;
  } catch (e) {
    return 0;
  }
}

// Límite efectivo de una clave: si el cliente tiene un límite personalizado
// fijado desde el panel de admin, ese gana. Si no, se usa el default del plan.
async function obtenerLimite(apiKey, plan) {
  try {
    const registro = await obtenerApiKey(apiKey);
    if (registro && registro.limiteMensual !== undefined && registro.limiteMensual !== null) {
      return registro.limiteMensual;
    }
  } catch (e) { /* cae al default del plan */ }
  return LIMITES[plan] ?? LIMITES[PLAN_DEFAULT];
}

// Antes de procesar un análisis: ¿esta API key ya llegó a su límite del mes?
async function verificarLimite(apiKey) {
  if (!apiKey) return { permitido: true, plan: null, uso: 0, limite: null, modo: 'abierto' };
  if (!estaDisponible()) return { permitido: true, plan: PLAN_DEFAULT, uso: 0, limite: null, modo: 'sin_persistencia' };

  const plan = await obtenerPlan(apiKey);
  const uso = await obtenerUso(apiKey);
  const limite = await obtenerLimite(apiKey, plan);
  return { permitido: uso < limite, plan, uso, limite, modo: 'normal' };
}

// Deduplicación informativa por hash de archivo — no penaliza, solo informa
// si este documento exacto ya se había analizado antes.
async function registrarHashDocumento(hash) {
  const cliente = obtenerCliente();
  if (!cliente) return { vecesVisto: 1, disponible: false };
  try {
    const clave = `hash:${hash}`;
    const veces = await cliente.incr(clave);
    if (veces === 1) await cliente.expire(clave, 60 * 60 * 24 * 180); // 180 días
    return { vecesVisto: veces, disponible: true };
  } catch (e) {
    return { vecesVisto: 1, disponible: false };
  }
}

module.exports = {
  obtenerPlan, establecerPlan, obtenerLimite, incrementarUso, obtenerUso,
  verificarLimite, registrarHashDocumento, LIMITES,
};
