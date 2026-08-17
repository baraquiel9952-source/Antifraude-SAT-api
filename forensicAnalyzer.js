// Motor de análisis forense de PDFs — Antifraude SAT
// Trabaja directo sobre los bytes crudos del PDF (sin dependencias externas de parsing).

function contarMarcadoresEOF(buffer) {
  const texto = buffer.toString('latin1');
  const matches = texto.match(/%%EOF/g);
  return matches ? matches.length : 0;
}

function contarSeccionesXref(buffer) {
  const texto = buffer.toString('latin1');
  const xrefClasico = texto.match(/\bxref\r?\n/g) || [];
  const xrefStream = texto.match(/\/Type\s*\/XRef\b/g) || [];
  return xrefClasico.length + xrefStream.length;
}

function parseFechaPDF(raw) {
  // Formato PDF: D:YYYYMMDDHHmmSS
  if (!raw) return null;
  const m = raw.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

function extraerFechas(buffer) {
  const texto = buffer.toString('latin1');
  const creationRaw = (texto.match(/\/CreationDate\s*\(([^)]+)\)/) || [])[1];
  const modRaw = (texto.match(/\/ModDate\s*\(([^)]+)\)/) || [])[1];
  return {
    creacion: parseFechaPDF(creationRaw),
    modificacion: parseFechaPDF(modRaw),
  };
}

function detectarFirmaDigital(buffer) {
  const texto = buffer.toString('latin1');
  const tieneSig = /\/Type\s*\/Sig\b/.test(texto);
  const tieneByteRange = /\/ByteRange/.test(texto);
  const tieneSubFilter = /\/SubFilter\s*\/(adbe\.pkcs7|ETSI)/i.test(texto);
  return {
    presente: tieneSig && tieneByteRange,
    con_certificado_reconocido: tieneSubFilter,
  };
}

function analizarPDF(buffer) {
  const eofCount = contarMarcadoresEOF(buffer);
  const xrefCount = contarSeccionesXref(buffer);
  const fechas = extraerFechas(buffer);
  const firma = detectarFirmaDigital(buffer);

  let score = 100;
  const anomalias = [];

  if (eofCount > 1) {
    const penalizacion = Math.min((eofCount - 1) * 15, 40);
    score -= penalizacion;
    anomalias.push({
      tipo: 'ediciones_incrementales',
      severidad: eofCount > 2 ? 'alta' : 'media',
      detalle: `Se detectaron ${eofCount} marcadores %%EOF. El archivo fue guardado ${eofCount} veces, lo que indica posibles modificaciones posteriores a su generación original.`,
    });
  }

  if (xrefCount > 1) {
    score -= 10;
    anomalias.push({
      tipo: 'xref_multiple',
      severidad: 'media',
      detalle: `Se encontraron ${xrefCount} tablas de referencias cruzadas (XREF), consistente con ediciones incrementales del documento.`,
    });
  }

  if (fechas.creacion && fechas.modificacion) {
    const diffHoras = (fechas.modificacion - fechas.creacion) / 3.6e6;
    if (diffHoras > 1) {
      score -= 15;
      anomalias.push({
        tipo: 'timeline_inconsistente',
        severidad: 'alta',
        detalle: `La fecha de modificación es ${diffHoras.toFixed(1)} horas posterior a la de creación.`,
      });
    }
  }

  if (!firma.presente) {
    score -= 20;
    anomalias.push({
      tipo: 'sin_firma_digital',
      severidad: 'alta',
      detalle: 'El documento no contiene una firma digital detectable (se esperaría en una constancia oficial sellada por el SAT).',
    });
  } else if (!firma.con_certificado_reconocido) {
    score -= 10;
    anomalias.push({
      tipo: 'firma_sin_certificado_reconocido',
      severidad: 'media',
      detalle: 'Hay firma digital, pero no se pudo confirmar un certificado de tipo reconocido (Adobe PKCS7 / ETSI).',
    });
  }

  score = Math.max(0, Math.min(100, score));

  let veredicto = 'legitimo';
  if (score < 40) veredicto = 'fraudulento';
  else if (score < 70) veredicto = 'sospechoso';

  return {
    score,
    veredicto,
    anomalias,
    detalles_tecnicos: {
      marcadores_eof: eofCount,
      secciones_xref: xrefCount,
      fecha_creacion: fechas.creacion,
      fecha_modificacion: fechas.modificacion,
      firma_digital: firma,
    },
  };
}

module.exports = { analizarPDF };
