// Motor de análisis forense de PDFs — Antifraude SAT
// v2.0.0-forense
//
// Origen: port de la lógica de ActaForensic Pro (motor Android/AIDE para actas de
// nacimiento) adaptada a documentos fiscales, más 15 mejoras nuevas sobre esa base.
//
// Trabaja sin dependencias de parsing de PDF completo: extrae y descomprime los
// streams FlateDecode a mano (igual que hacía ForensicScanner.java con Inflater,
// aquí con zlib) y aplica heurísticas sobre el texto crudo + el texto descomprimido.

const zlib = require('zlib');

const ENGINE_VERSION = '2.0.0-forense';

// ---------------------------------------------------------------------------
// [PORT] Lista blanca de software legítimo conocido (de ActaForensic Pro,
// ampliada con generadores típicos de portales de gobierno / contables MX)
// ---------------------------------------------------------------------------
const LEGIT_TOOLS = [
  'oracle xml publisher', 'bi publisher', 'itext', 'wkhtmltopdf', 'pdfbox',
  'adobe', 'acrobat', 'libreoffice', 'openoffice', 'chromium', 'skia/pdf',
  'prince', 'jasperreports', 'crystal reports', 'sat', 'generadorsat',
  'tcpdf', 'fpdf', 'reportlab', 'apache fop', 'quadient',
];

// ---------------------------------------------------------------------------
// Utilidades de bajo nivel
// ---------------------------------------------------------------------------

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
  if (!raw) return null;
  const m = raw.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

function extraerFechas(texto) {
  const creationRaw = (texto.match(/\/CreationDate\s*\(([^)]+)\)/) || [])[1];
  const modRaw = (texto.match(/\/ModDate\s*\(([^)]+)\)/) || [])[1];
  return {
    creacion: parseFechaPDF(creationRaw),
    modificacion: parseFechaPDF(modRaw),
  };
}

// [MEJORA 1] Descomprime TODOS los streams FlateDecode del archivo (incluye
// content streams normales y ObjStm — streams de objetos comprimidos que en
// PDF 1.5+ suelen contener el diccionario de firma, metadata, AcroForm, etc.
// Sin esto, cualquier cosa empacada dentro de un stream comprimido es invisible
// para el análisis por texto plano — esto es lo que causó el falso positivo
// "sin firma digital" en documentos que sí la traían, solo que comprimida.
function descomprimirStreams(buffer) {
  const texto = buffer.toString('latin1');
  const partes = [];
  const re = /<<[^>]*?\/Filter\s*\/FlateDecode[^>]*?>>\s*stream\r?\n/g;
  let m;
  let streamsIntentados = 0;
  let streamsOk = 0;

  while ((m = re.exec(texto)) !== null) {
    streamsIntentados++;
    const inicio = m.index + m[0].length;
    const finIdx = texto.indexOf('endstream', inicio);
    if (finIdx === -1) continue;

    let crudo = buffer.slice(inicio, finIdx);
    while (crudo.length && (crudo[crudo.length - 1] === 0x0a || crudo[crudo.length - 1] === 0x0d)) {
      crudo = crudo.slice(0, -1);
    }
    try {
      const inflado = zlib.inflateSync(crudo);
      partes.push(inflado.toString('latin1'));
      streamsOk++;
    } catch (e) {
      // stream corrupto o con filtro encadenado — se ignora, no se descarta el resto
    }
  }

  return {
    textoDescomprimido: partes.join('\n'),
    streamsIntentados,
    streamsOk,
  };
}

// [MEJORA 2] Compara el /ID del trailer entre todas las secciones del archivo.
// El primer elemento del /ID debe mantenerse IGUAL entre revisiones incrementales
// legítimas. Si cambia, el archivo probablemente no es una cadena de guardados
// incrementales real sino uno reconstruido/mezclado.
function validarIdTrailer(texto) {
  const re = /\/ID\s*\[\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\]/g;
  const ids = [];
  let m;
  while ((m = re.exec(texto)) !== null) ids.push(m[1].toLowerCase());
  if (ids.length <= 1) return { consistente: true, ocurrencias: ids.length };
  const primero = ids[0];
  const consistente = ids.every(id => id === primero);
  return { consistente, ocurrencias: ids.length };
}

// [MEJORA 3] Verifica que el /ByteRange de la firma cubra casi todo el archivo.
function validarByteRange(texto, tamanoArchivo) {
  const m = texto.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
  if (!m) return null;
  const len1 = Number(m[2]);
  const len2 = Number(m[4]);
  const cobertura = (len1 + len2) / tamanoArchivo;
  return { cobertura, suficiente: cobertura >= 0.85 };
}

// [MEJORA 4] Reconstruye la cadena real de revisiones siguiendo /Prev, en vez de
// solo contar %%EOF. Si hay más secciones xref/trailer que eslabones en la
// cadena, hay fragmentos "sueltos" no enlazados — señal de manipulación.
function reconstruirCadenaPrev(texto) {
  const startxrefs = [...texto.matchAll(/startxref\s+(\d+)/g)].map(m => +m[1]);
  if (startxrefs.length === 0) return { revisionesEnlazadas: 0, prevEncontrados: 0 };
  const prevs = [...texto.matchAll(/\/Prev\s+(\d+)/g)].map(m => +m[1]);
  const distintos = new Set(prevs);
  return { revisionesEnlazadas: 1 + distintos.size, prevEncontrados: prevs.length };
}

// [MEJORA 5] Detecta JavaScript embebido / acciones automáticas al abrir.
function detectarJavaScript(texto) {
  return /\/JavaScript\b/.test(texto) || /\/JS\b/.test(texto) || /\/OpenAction\b/.test(texto);
}

// [MEJORA 6] AcroForm con campos sin aplanar (editables después de "finalizado").
function detectarFormularioActivo(texto) {
  const tieneAcroForm = /\/AcroForm\b/.test(texto);
  const tieneCampos = /\/FT\s*\/(Tx|Btn|Ch)\b/.test(texto);
  return tieneAcroForm && tieneCampos;
}

// [MEJORA 7] Detecta cifrado — limita qué tanto se puede garantizar del análisis.
function detectarCifrado(texto) {
  return /\/Encrypt\b/.test(texto);
}

// [MEJORA 8] Sanity check /Size del trailer vs. objetos realmente referenciados.
function validarSizeVsObjetos(texto) {
  const sizeMatch = texto.match(/\/Size\s+(\d+)/);
  if (!sizeMatch) return null;
  const size = +sizeMatch[1];
  const objIds = [...texto.matchAll(/\b(\d+)\s+0\s+obj\b/g)].map(m => +m[1]);
  if (objIds.length === 0) return null;
  const maxObj = Math.max(...objIds);
  return { size, maxObjetoEncontrado: maxObj, coincide: maxObj < size };
}

// [PORT] Software del /Producer o /Creator — contra la whitelist de ActaForensic Pro
function extraerSoftware(texto) {
  const prod = (texto.match(/\/Producer\s*\(([^)]*)\)/) || [])[1] || '';
  const creator = (texto.match(/\/Creator\s*\(([^)]*)\)/) || [])[1] || '';
  const combinado = (prod + ' ' + creator).toLowerCase();
  const esLegitimo = LEGIT_TOOLS.some(tool => combinado.includes(tool));
  return { productor: prod || null, creador: creator || null, esLegitimo };
}

// [MEJORA 9] Identificación fiscal (RFC/idCIF) — campos clave para el combo-penalty portado.
function extraerIdentificacionFiscal(texto) {
  const rfc = (texto.match(/\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/) || [])[0] || null;
  const idcif = (texto.match(/\bidCIF\s*[:\-]?\s*([A-Za-z0-9]{6,})/i) || [])[1] || null;
  return { rfc, idcif };
}

function detectarFirmaDigital(texto) {
  const tieneSig = /\/Type\s*\/Sig\b/.test(texto);
  const tieneByteRange = /\/ByteRange/.test(texto);
  const tieneSubFilter = /\/SubFilter\s*\/(adbe\.pkcs7|ETSI)/i.test(texto);
  return {
    presente: tieneSig && tieneByteRange,
    con_certificado_reconocido: tieneSubFilter,
  };
}

// [MEJORA 10] Bajo contenido de texto real => posible PDF escaneado (imagen).
function detectarBajoContenidoTexto(texto) {
  const marcadores = (texto.match(/\bT[jJ]\b/g) || []).length;
  return marcadores < 3;
}

/**
 * @param {Buffer} buffer - bytes crudos del PDF
 * @param {Object} opts
 * @param {string} [opts.tipoDocumento] - 'constancia_fiscal' | 'acta' | 'generico'
 */
function analizarPDF(buffer, opts = {}) {
  const tipoDocumento = opts.tipoDocumento || 'constancia_fiscal';
  const textoRaw = buffer.toString('latin1');
  const { textoDescomprimido, streamsIntentados, streamsOk } = descomprimirStreams(buffer);
  const textoCompleto = textoRaw + '\n' + textoDescomprimido;

  const eofCount = contarMarcadoresEOF(buffer);
  const xrefCount = contarSeccionesXref(buffer);
  const fechas = extraerFechas(textoCompleto);
  const firma = detectarFirmaDigital(textoCompleto);
  const software = extraerSoftware(textoCompleto);
  const identificacion = extraerIdentificacionFiscal(textoCompleto);
  const idTrailer = validarIdTrailer(textoRaw);
  const byteRange = validarByteRange(textoCompleto, buffer.length);
  const cadenaPrev = reconstruirCadenaPrev(textoRaw);
  const tieneJS = detectarJavaScript(textoCompleto);
  const formularioActivo = detectarFormularioActivo(textoCompleto);
  const cifrado = detectarCifrado(textoRaw);
  const sizeCheck = validarSizeVsObjetos(textoRaw);
  const bajoTexto = detectarBajoContenidoTexto(textoCompleto);

  let score = 100;
  const anomalias = [];
  let camposClaveAusentes = 0;
  let scoreCapReason = null;
  let confianza = 'alta';

  if (eofCount > 1) {
    const penalizacion = Math.min((eofCount - 1) * 12, 35);
    score -= penalizacion;
    anomalias.push({
      tipo: 'ediciones_incrementales',
      severidad: eofCount > 2 ? 'alta' : 'media',
      detalle: `Se detectaron ${eofCount} marcadores %%EOF. El archivo fue guardado ${eofCount} veces.`,
    });
  }

  if (xrefCount > 1) {
    score -= 8;
    anomalias.push({
      tipo: 'xref_multiple',
      severidad: 'media',
      detalle: `Se encontraron ${xrefCount} tablas de referencias cruzadas (XREF).`,
    });
  }

  if (cadenaPrev.revisionesEnlazadas > 0 && eofCount > cadenaPrev.revisionesEnlazadas) {
    score -= 15;
    anomalias.push({
      tipo: 'cadena_xref_rota',
      severidad: 'alta',
      detalle: `Hay ${eofCount} marcadores %%EOF pero solo ${cadenaPrev.revisionesEnlazadas} quedan enlazados por /Prev — la tabla de referencias no forma una cadena coherente.`,
    });
  }

  if (!idTrailer.consistente) {
    score -= 20;
    anomalias.push({
      tipo: 'id_trailer_inconsistente',
      severidad: 'alta',
      detalle: `El identificador /ID del archivo cambió entre revisiones (${idTrailer.ocurrencias} ocurrencias) — no coincide con una edición incremental normal.`,
    });
  }

  if (fechas.creacion && fechas.modificacion) {
    const diffHoras = (fechas.modificacion - fechas.creacion) / 3.6e6;
    if (diffHoras > 1) {
      score -= 12;
      anomalias.push({
        tipo: 'timeline_inconsistente',
        severidad: 'alta',
        detalle: `La fecha de modificación es ${diffHoras.toFixed(1)} horas posterior a la de creación.`,
      });
    }
  }

  if (!firma.presente) {
    camposClaveAusentes++;
    if (tipoDocumento === 'constancia_fiscal') {
      anomalias.push({
        tipo: 'sin_firma_digital',
        severidad: 'media',
        detalle: 'No se detectó firma digital embebida. En constancias del SAT esto es normal: la verificación oficial es por QR / cadena original, no reemplaza esa validación.',
      });
    } else {
      score -= 20;
      anomalias.push({
        tipo: 'sin_firma_digital',
        severidad: 'alta',
        detalle: 'El documento no contiene una firma digital detectable.',
      });
    }
  } else if (!firma.con_certificado_reconocido) {
    score -= 8;
    anomalias.push({
      tipo: 'firma_sin_certificado_reconocido',
      severidad: 'media',
      detalle: 'Hay firma digital, pero no se confirmó un certificado de tipo reconocido (Adobe PKCS7 / ETSI).',
    });
  } else if (byteRange && !byteRange.suficiente) {
    score -= 25;
    anomalias.push({
      tipo: 'byterange_insuficiente',
      severidad: 'alta',
      detalle: `El /ByteRange de la firma solo cubre ${(byteRange.cobertura * 100).toFixed(0)}% del archivo — una firma real cubre casi todo el documento.`,
    });
  }

  if (!identificacion.rfc && !identificacion.idcif) camposClaveAusentes++;
  if (!fechas.creacion) camposClaveAusentes++;

  if (camposClaveAusentes >= 3) {
    score -= 20;
    anomalias.push({
      tipo: 'combo_identificacion_ausente',
      severidad: 'alta',
      detalle: 'Faltan simultáneamente 3 o más campos clave de identificación (firma, RFC/idCIF, fecha de creación).',
    });
  }
  if (!identificacion.rfc && !identificacion.idcif && !fechas.creacion) {
    scoreCapReason = 'sin ningún dato de identificación fiscal ni fecha de creación';
  }

  if (tieneJS) {
    score -= 25;
    anomalias.push({
      tipo: 'javascript_embebido',
      severidad: 'alta',
      detalle: 'El documento contiene JavaScript o una acción automática al abrirse — no debería existir en un documento fiscal estático.',
    });
  }

  if (formularioActivo) {
    score -= 10;
    anomalias.push({
      tipo: 'formulario_activo',
      severidad: 'media',
      detalle: 'El documento contiene campos de formulario (AcroForm) todavía editables.',
    });
  }

  if (cifrado) {
    confianza = 'baja';
    anomalias.push({
      tipo: 'documento_cifrado',
      severidad: 'media',
      detalle: 'El PDF está cifrado — no se puede garantizar un análisis estructural completo.',
    });
  }

  if (sizeCheck && !sizeCheck.coincide) {
    score -= 15;
    anomalias.push({
      tipo: 'size_objetos_inconsistente',
      severidad: 'alta',
      detalle: `El trailer declara ${sizeCheck.size} objetos pero se referencian objetos hasta el número ${sizeCheck.maxObjetoEncontrado}.`,
    });
  }

  if (bajoTexto) {
    confianza = confianza === 'alta' ? 'media' : confianza;
    anomalias.push({
      tipo: 'bajo_contenido_texto',
      severidad: 'media',
      detalle: 'El documento tiene muy poco texto real extraíble — podría ser un escaneo/imagen sin capa de texto.',
    });
  }

  if (!software.esLegitimo && (software.productor || software.creador)) {
    score -= 5;
    anomalias.push({
      tipo: 'software_no_reconocido',
      severidad: 'media',
      detalle: `El software que generó el documento (${software.productor || software.creador}) no está en la lista de generadores conocidos.`,
    });
  } else if (!software.productor && !software.creador) {
    score -= 10;
    confianza = confianza === 'alta' ? 'media' : confianza;
    anomalias.push({
      tipo: 'software_desconocido',
      severidad: 'media',
      detalle: 'No se pudo identificar el software que generó el documento (sin /Producer ni /Creator).',
    });
  }

  const notaDescompresion = streamsIntentados > 0
    ? `${streamsOk}/${streamsIntentados} streams comprimidos descomprimidos y revisados.`
    : 'El documento no usa streams comprimidos (FlateDecode).';

  score = Math.max(0, Math.min(100, score));

  if (scoreCapReason && score > 70) {
    score = 70;
    anomalias.push({
      tipo: 'score_limitado',
      severidad: 'media',
      detalle: `El score se limitó a 70 como máximo: ${scoreCapReason}.`,
    });
  }

  let veredicto = 'legitimo';
  if (score < 40) veredicto = 'fraudulento';
  else if (score < 70) veredicto = 'sospechoso';

  return {
    score,
    veredicto,
    confianza,
    engine_version: ENGINE_VERSION,
    tipo_documento: tipoDocumento,
    anomalias,
    detalles_tecnicos: {
      marcadores_eof: eofCount,
      secciones_xref: xrefCount,
      revisiones_enlazadas_prev: cadenaPrev.revisionesEnlazadas,
      id_trailer_consistente: idTrailer.consistente,
      fecha_creacion: fechas.creacion,
      fecha_modificacion: fechas.modificacion,
      firma_digital: firma,
      byte_range: byteRange,
      software,
      identificacion_fiscal: identificacion,
      javascript_embebido: tieneJS,
      formulario_activo: formularioActivo,
      cifrado,
      descompresion: notaDescompresion,
    },
  };
}

module.exports = { analizarPDF, ENGINE_VERSION, LEGIT_TOOLS };
