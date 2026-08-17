const express = require('express');
const multer = require('multer');
const { analizarPDF } = require('./lib/forensicAnalyzer');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

// --- Autenticación simple por API key ---
// Configura API_KEYS en las variables de entorno de Render, separadas por coma.
// Ejemplo: API_KEYS=clave-cliente1,clave-cliente2
function verificarApiKey(req, res, next) {
  const clavesValidas = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  const clave = req.headers['x-api-key'];

  if (clavesValidas.length === 0) {
    // Sin API_KEYS configuradas: modo abierto (útil en desarrollo local)
    return next();
  }
  if (!clave || !clavesValidas.includes(clave)) {
    return res.status(401).json({ error: 'API key inválida o ausente. Envía el header x-api-key.' });
  }
  next();
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/verificar', verificarApiKey, upload.single('documento'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Falta el archivo PDF en el campo "documento".' });
  }
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: 'Solo se aceptan archivos PDF.' });
  }

  try {
    const resultado = analizarPDF(req.file.buffer);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: 'Error al analizar el documento.', detalle: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Antifraude SAT API corriendo en puerto ${PORT}`);
});
