// Combina el análisis estructural (forensicAnalyzer) con el análisis de QR/dominio
// (qrAnalyzer) en un solo resultado — así el cliente de la API recibe un veredicto
// unificado sin tener que llamar dos endpoints ni correr pdf.js/jsQR por su cuenta.

const crypto = require('crypto');
const { analizarPDF } = require('./forensicAnalyzer');
const { analizarQR } = require('./qrAnalyzer');
const { registrarHashDocumento } = require('./planes');
const { extraerTextoCompleto } = require('./textExtractor');
const { extraerCamposFiscales, validarCamposFiscales } = require('./validacionFiscal');

async function analizarCompleto(buffer, opts = {}) {
  const estructural = analizarPDF(buffer, opts);
  const qr = await analizarQR(buffer, null);

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const dedupe = await registrarHashDocumento(hash);

  // Texto real (no bytes crudos) para RFC/CURP/Cadena Original — arregla el
  // bug donde el RFC no se detectaba porque el PDF lo parte en fragmentos.
  let camposFiscales = { rfc: null, curp: null, idcif: null, cadenaOriginal: null, selloDigital: null };
  let validacionFiscal = { anomalias: [], detalle: {} };
  try {
    const textoReal = await extraerTextoCompleto(buffer);
    camposFiscales = extraerCamposFiscales(textoReal);
    validacionFiscal = validarCamposFiscales(camposFiscales);
  } catch (e) {
    // Si el PDF no permite extracción de texto (raro, ej. escaneado sin capa de texto),
    // seguimos con lo que ya tenía el análisis estructural.
  }

  let scoreFinal = Math.max(0, Math.min(100, estructural.score + qr.scoreDelta - validacionFiscal.anomalias.reduce((s, a) => s + (a.severidad === 'alta' ? 20 : 8), 0)));

  let veredicto = 'legitimo';
  if (scoreFinal < 40) veredicto = 'fraudulento';
  else if (scoreFinal < 70) veredicto = 'sospechoso';

  const anomaliasCombinadas = [...estructural.anomalias, ...qr.anomalias, ...validacionFiscal.anomalias];

  return {
    ...estructural,
    score: scoreFinal,
    veredicto,
    anomalias: anomaliasCombinadas,
    detalles_tecnicos: {
      ...estructural.detalles_tecnicos,
      hash_documento: hash,
      veces_visto: dedupe.vecesVisto,
      identificacion_fiscal: {
        rfc: camposFiscales.rfc,
        curp: camposFiscales.curp,
        idcif: camposFiscales.idcif,
        ...validacionFiscal.detalle,
      },
      cadena_original_detectada: !!camposFiscales.cadenaOriginal,
      sello_digital_detectado: !!camposFiscales.selloDigital,
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
