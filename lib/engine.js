// Combina el análisis estructural (forensicAnalyzer) con el análisis de QR/dominio
// (qrAnalyzer) en un solo resultado — así el cliente de la API recibe un veredicto
// unificado sin tener que llamar dos endpoints ni correr pdf.js/jsQR por su cuenta.

const crypto = require('crypto');
const { analizarPDF } = require('./forensicAnalyzer');
const { analizarQR } = require('./qrAnalyzer');
const { registrarHashDocumento } = require('./planes');

async function analizarCompleto(buffer, opts = {}) {
  const estructural = analizarPDF(buffer, opts);
  const rfcDetectado = estructural.detalles_tecnicos.identificacion_fiscal.rfc;
  const qr = await analizarQR(buffer, rfcDetectado);

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const dedupe = await registrarHashDocumento(hash);

  let scoreFinal = Math.max(0, Math.min(100, estructural.score + qr.scoreDelta));

  let veredicto = 'legitimo';
  if (scoreFinal < 40) veredicto = 'fraudulento';
  else if (scoreFinal < 70) veredicto = 'sospechoso';

  const anomaliasCombinadas = [...estructural.anomalias, ...qr.anomalias];

  return {
    ...estructural,
    score: scoreFinal,
    veredicto,
    anomalias: anomaliasCombinadas,
    detalles_tecnicos: {
      ...estructural.detalles_tecnicos,
      hash_documento: hash,
      veces_visto: dedupe.vecesVisto,
      analisis_qr: {
        disponible: qr.disponible,
        qrs_encontrados: qr.qrs_encontrados,
        paginas_escaneadas: qr.paginas_escaneadas,
        total_paginas: qr.total_paginas,
        dominios_confirmados_gob: qr.dominios_confirmados_gob,
        qrs: qr.qrs,
        error: qr.error,
      },
    },
  };
}

module.exports = { analizarCompleto };
