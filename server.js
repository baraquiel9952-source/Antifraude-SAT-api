const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { analizarCompleto } = require('./lib/engine');
const { generarReportePDF } = require('./lib/reportGenerator');
const { verificarLimite, incrementarUso, obtenerUso, establecerPlan, LIMITES } = require('./lib/planes');
const { ENGINE_VERSION } = require('./lib/forensicAnalyzer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

const { crearApiKey, listarApiKeys, revocarApiKey, obtenerApiKey, actualizarWebhookApiKey } = require('./lib/apiKeys');
const { estaDisponible } = require('./lib/store');
const { guardarAnalisis, obtenerHistorial } = require('./lib/historial');
const { notificarSiFraudulento } = require('./lib/webhooks');

async function verificarApiKey(req, res, next) {
  const clavesEstaticas = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  const clave = req.headers['x-api-key'];

  // Modo completamente abierto: sin claves estáticas Y sin Redis conectado (desarrollo puro)
  if (clavesEstaticas.length === 0 && !estaDisponible()) {
    return next();
  }

  if (!clave) {
    return res.status(401).json({ error: 'API key ausente. Envía el header x-api-key.' });
  }

  // Clave estática de arranque (definida en API_KEYS)
  if (clavesEstaticas.includes(clave)) {
    req.apiKey = clave;
    return next();
  }

  // Clave dinámica dada de alta vía /api/admin/keys — válida sin redeploy
  const registro = await obtenerApiKey(clave);
  if (registro && registro.activa !== false) {
    req.apiKey = clave;
    req.apiKeyInfo = registro;
    return next();
  }

  return res.status(401).json({ error: 'API key inválida.' });
}

// [PIEZA 2] Bloquea la petición si la API key ya llegó a su límite del plan.
async function verificarPlan(req, res, next) {
  const estado = await verificarLimite(req.apiKey);
  req.estadoPlan = estado;
  if (!estado.permitido) {
    return res.status(429).json({
      error: `Límite del plan "${estado.plan}" alcanzado (${estado.uso}/${estado.limite} análisis este mes).`,
      plan: estado.plan,
      sugerencia: 'Actualiza a un plan de mayor capacidad para seguir analizando documentos.',
    });
  }
  next();
}

function verificarAdmin(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    return res.status(503).json({ error: 'Panel de administración no configurado (falta ADMIN_KEY).' });
  }
  if (req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Clave de administrador inválida.' });
  }
  next();
}

const TIPOS_VALIDOS = ['constancia_fiscal', 'acta', 'generico'];
function normalizarTipoDocumento(valor) {
  return TIPOS_VALIDOS.includes(valor) ? valor : 'constancia_fiscal';
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', engine_version: ENGINE_VERSION });
});

// --- Verificación individual (estructura + QR combinados) ---
app.post('/api/verificar', verificarApiKey, verificarPlan, upload.single('documento'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Falta el archivo PDF en el campo "documento".' });
  }
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: 'Solo se aceptan archivos PDF.' });
  }

  try {
    const tipoDocumento = normalizarTipoDocumento(req.body.tipo_documento);
    const resultado = await analizarCompleto(req.file.buffer, { tipoDocumento });
    await incrementarUso(req.apiKey);
    await guardarAnalisis(req.apiKey, resultado, req.file.originalname);
    notificarSiFraudulento(req.apiKeyInfo?.webhookUrl, resultado, req.apiKeyInfo);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: 'Error al analizar el documento.', detalle: err.message });
  }
});

// Verificación en lote — varios PDFs en una sola llamada.
app.post('/api/verificar-lote', verificarApiKey, verificarPlan, upload.array('documentos', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Falta al menos un archivo PDF en el campo "documentos".' });
  }

  const tipoDocumento = normalizarTipoDocumento(req.body.tipo_documento);
  const resultados = [];
  for (const file of req.files) {
    if (file.mimetype !== 'application/pdf') {
      resultados.push({ archivo: file.originalname, error: 'No es un PDF válido.' });
      continue;
    }
    try {
      const resultado = await analizarCompleto(file.buffer, { tipoDocumento });
      resultados.push({ archivo: file.originalname, ...resultado });
    } catch (err) {
      resultados.push({ archivo: file.originalname, error: err.message });
    }
  }

  await incrementarUso(req.apiKey);
  res.json({ total: resultados.length, resultados });
});

// Consulta de uso y plan de la propia API key.
app.get('/api/uso', verificarApiKey, async (req, res) => {
  if (!req.apiKey) {
    return res.status(400).json({ error: 'Este endpoint requiere una API key.' });
  }
  const estado = await verificarLimite(req.apiKey);
  res.json({
    api_key: req.apiKey,
    plan: estado.plan,
    verificaciones_este_mes: estado.uso,
    limite_mensual: estado.limite,
    modo: estado.modo,
  });
});

// Reporte PDF descargable a partir de un resultado previo de /api/verificar.
app.get('/api/historial', verificarApiKey, async (req, res) => {
  if (!req.apiKey) {
    return res.status(400).json({ error: 'Este endpoint requiere una API key.' });
  }
  const limite = Math.min(parseInt(req.query.limite, 10) || 50, 200);
  const historial = await obtenerHistorial(req.apiKey, limite);
  res.json({ total: historial.length, historial });
});

app.post('/api/reporte', verificarApiKey, (req, res) => {
  const { resultado, nombre_documento } = req.body || {};
  if (!resultado || !resultado.veredicto) {
    return res.status(400).json({ error: 'Falta el campo "resultado" con la respuesta previa de /api/verificar.' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="reporte-antifraude-sat.pdf"');
  try {
    generarReportePDF(resultado, nombre_documento, res);
  } catch (err) {
    res.status(500).json({ error: 'No se pudo generar el reporte.', detalle: err.message });
  }
});

// --- Administración de planes (protegido por ADMIN_KEY, no por x-api-key) ---
app.post('/api/admin/plan', verificarAdmin, async (req, res) => {
  const { api_key, plan } = req.body || {};
  if (!api_key || !plan) {
    return res.status(400).json({ error: 'Faltan "api_key" y/o "plan" en el body.' });
  }
  try {
    await establecerPlan(api_key, plan);
    res.json({ ok: true, api_key, plan });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/planes-disponibles', verificarAdmin, (req, res) => {
  res.json({ planes: LIMITES });
});

// --- Alta/baja de API keys sin redeploy ---
app.post('/api/admin/keys', verificarAdmin, async (req, res) => {
  const { nombre_cliente, plan } = req.body || {};
  try {
    const nueva = await crearApiKey({ nombreCliente: nombre_cliente, plan: plan || 'free' });
    res.json({ ok: true, ...nueva });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/keys', verificarAdmin, async (req, res) => {
  const keys = await listarApiKeys();
  const keysConUso = await Promise.all(keys.map(async k => {
    const uso = await obtenerUso(k.clave);
    const limite = LIMITES[k.plan] ?? LIMITES.free;
    return { ...k, verificaciones_este_mes: uso, limite_mensual: limite };
  }));
  res.json({ total: keysConUso.length, keys: keysConUso });
});

app.delete('/api/admin/keys/:clave', verificarAdmin, async (req, res) => {
  try {
    await revocarApiKey(req.params.clave);
    res.json({ ok: true, revocada: req.params.clave });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/webhook', verificarAdmin, async (req, res) => {
  const { api_key, webhook_url } = req.body || {};
  if (!api_key) return res.status(400).json({ error: 'Falta "api_key" en el body.' });
  const actualizado = await actualizarWebhookApiKey(api_key, webhook_url);
  if (!actualizado) return res.status(404).json({ error: 'Esa API key no tiene un registro dinámico (no se puede configurar webhook en claves estáticas).' });
  res.json({ ok: true, api_key, webhook_url: webhook_url || null });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Antifraude SAT API (${ENGINE_VERSION}) corriendo en puerto ${PORT}`);
});
