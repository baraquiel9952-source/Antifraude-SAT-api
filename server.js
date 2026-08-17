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

function verificarApiKey(req, res, next) {
  const clavesValidas = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  const clave = req.headers['x-api-key'];

  if (clavesValidas.length === 0) {
    // Sin API_KEYS configuradas: modo abierto (desarrollo) — sin límites de plan.
    return next();
  }
  if (!clave || !clavesValidas.includes(clave)) {
    return res.status(401).json({ error: 'API key inválida o ausente. Envía el header x-api-key.' });
  }
  req.apiKey = clave;
  next();
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Antifraude SAT API (${ENGINE_VERSION}) corriendo en puerto ${PORT}`);
});
