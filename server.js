const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { analizarPDF, ENGINE_VERSION } = require('./lib/forensicAnalyzer');
const { generarReportePDF } = require('./lib/reportGenerator');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

// [MEJORA 14] Contador de uso por API key (en memoria — reinicia si el servicio
// se reinicia; suficiente para arrancar, se puede pasar a una base de datos después).
const usoPorApiKey = new Map();

function registrarUso(apiKey) {
  if (!apiKey) return;
  usoPorApiKey.set(apiKey, (usoPorApiKey.get(apiKey) || 0) + 1);
}

function verificarApiKey(req, res, next) {
  const clavesValidas = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  const clave = req.headers['x-api-key'];

  if (clavesValidas.length === 0) {
    // Sin API_KEYS configuradas: modo abierto (desarrollo)
    return next();
  }
  if (!clave || !clavesValidas.includes(clave)) {
    return res.status(401).json({ error: 'API key inválida o ausente. Envía el header x-api-key.' });
  }
  req.apiKey = clave;
  next();
}

const TIPOS_VALIDOS = ['constancia_fiscal', 'acta', 'generico'];
function normalizarTipoDocumento(valor) {
  return TIPOS_VALIDOS.includes(valor) ? valor : 'constancia_fiscal';
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', engine_version: ENGINE_VERSION });
});

// --- Verificación individual ---
app.post('/api/verificar', verificarApiKey, upload.single('documento'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Falta el archivo PDF en el campo "documento".' });
  }
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: 'Solo se aceptan archivos PDF.' });
  }

  try {
    const tipoDocumento = normalizarTipoDocumento(req.body.tipo_documento);
    const resultado = analizarPDF(req.file.buffer, { tipoDocumento });
    registrarUso(req.apiKey);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: 'Error al analizar el documento.', detalle: err.message });
  }
});

// [MEJORA 13] Verificación en lote — varios PDFs en una sola llamada.
app.post('/api/verificar-lote', verificarApiKey, upload.array('documentos', 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Falta al menos un archivo PDF en el campo "documentos".' });
  }

  const tipoDocumento = normalizarTipoDocumento(req.body.tipo_documento);
  const resultados = req.files.map(file => {
    if (file.mimetype !== 'application/pdf') {
      return { archivo: file.originalname, error: 'No es un PDF válido.' };
    }
    try {
      const resultado = analizarPDF(file.buffer, { tipoDocumento });
      return { archivo: file.originalname, ...resultado };
    } catch (err) {
      return { archivo: file.originalname, error: err.message };
    }
  });

  registrarUso(req.apiKey);
  res.json({ total: resultados.length, resultados });
});

// [MEJORA 14] Consulta de uso — solo visible para la propia API key.
app.get('/api/uso', verificarApiKey, (req, res) => {
  if (!req.apiKey) {
    return res.status(400).json({ error: 'Este endpoint requiere una API key (modo abierto no lleva contador por cliente).' });
  }
  res.json({ api_key: req.apiKey, verificaciones_realizadas: usoPorApiKey.get(req.apiKey) || 0 });
});

// [MEJORA 15] Reporte PDF descargable a partir de un resultado ya obtenido de /api/verificar.
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Antifraude SAT API (${ENGINE_VERSION}) corriendo en puerto ${PORT}`);
});
