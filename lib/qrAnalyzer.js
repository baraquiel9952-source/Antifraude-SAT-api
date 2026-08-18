// [PIEZA 1] Motor de QR/dominio — port de la lógica de Antifraude_SAT_4_0.apk
// (assets/antifraude.html) al backend. Renderiza cada página del PDF con
// pdfjs-dist + @napi-rs/canvas, escanea códigos QR con jsQR, y valida el
// dominio de cada uno contra el patrón real de verificación del SAT.

const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { createCanvas } = require('@napi-rs/canvas');
const jsQR = require('jsqr');

// pdfjs-dist necesita una "canvasFactory" para renderizar sin DOM de navegador.
// @napi-rs/canvas se usa aquí en vez de node-canvas porque trae binarios N-API
// autocontenidos (sin depender de librerías del sistema como cairo/pango, que
// en plataformas con runtime restringido como Render pueden faltar en tiempo
// de ejecución aunque el build haya compilado bien).
class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    return { canvas, context };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

const ACORTADORES = ['bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 't.co', 'cutt.ly', 'rebrand.ly'];
const MAX_PAGINAS_ESCANEADAS = 5; // límite razonable de performance/costo por análisis

function clasificarDominio(urlTexto) {
  let hostname;
  try {
    hostname = new URL(urlTexto).hostname.toLowerCase();
  } catch (e) {
    return { hostname: null, esGob: false, esAcortador: false, imitaSat: false };
  }
  const esGob = hostname.endsWith('.gob.mx');
  const esAcortador = ACORTADORES.some(d => hostname === d || hostname.endsWith('.' + d));
  const imitaSat = /sat|cfdi|valid|fiscal|hacienda/i.test(hostname) && !esGob;
  return { hostname, esGob, esAcortador, imitaSat };
}

async function escanearQR(buffer) {
  const canvasFactory = new NodeCanvasFactory();
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), canvasFactory }).promise;
  const totalPaginas = doc.numPages;
  const qrs = [];

  for (let i = 1; i <= Math.min(totalPaginas, MAX_PAGINAS_ESCANEADAS); i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const { canvas, context } = canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));

    await page.render({ canvasContext: context, viewport, canvasFactory }).promise;

    const imgData = context.getImageData(0, 0, canvas.width, canvas.height);
    const resultado = jsQR(imgData.data, imgData.width, imgData.height);
    if (resultado && resultado.data) {
      const dominio = clasificarDominio(resultado.data);
      qrs.push({ pagina: i, contenido: resultado.data, ...dominio });
    }
  }

  return { qrs, paginasEscaneadas: Math.min(totalPaginas, MAX_PAGINAS_ESCANEADAS), totalPaginas };
}

// Aplica la lógica de scoring portada del APK (pesos SUSPICIOUS_DOMAIN, SHORTENER,
// MULTI_DOMAINS, GOB_QR_ONLY) traducida a la escala de confianza 0-100 de la API.
function evaluarQR(qrs) {
  const anomalias = [];
  let scoreDelta = 0;

  if (qrs.length === 0) {
    return { anomalias, scoreDelta, allGob: false, dominiosDistintos: 0 };
  }

  const dominiosDistintos = new Set(qrs.map(q => q.hostname).filter(Boolean));
  const allGob = qrs.every(q => q.esGob);

  qrs.forEach(q => {
    if (q.imitaSat) {
      scoreDelta -= 35;
      anomalias.push({
        tipo: 'qr_dominio_imitador',
        severidad: 'alta',
        detalle: `El QR apunta a "${q.hostname}", un dominio que imita al SAT sin ser .gob.mx. Los QR oficiales siempre terminan en .gob.mx.`,
      });
    } else if (q.esAcortador) {
      scoreDelta -= 20;
      anomalias.push({
        tipo: 'qr_acortador',
        severidad: 'alta',
        detalle: `El QR usa un acortador de URLs (${q.hostname}) — oculta el destino real, algo que un documento oficial nunca haría.`,
      });
    }
  });

  if (dominiosDistintos.size > 1) {
    scoreDelta -= 10;
    anomalias.push({
      tipo: 'qr_dominios_mixtos',
      severidad: 'media',
      detalle: `Los códigos QR del documento apuntan a ${dominiosDistintos.size} dominios distintos.`,
    });
  }

  if (allGob) {
    scoreDelta = Math.min(scoreDelta + 5, scoreDelta); // bonus leve, nunca sube más de lo que ya se restó
    anomalias.push({
      tipo: 'qr_gob_confirmado',
      severidad: 'informativa',
      detalle: `${qrs.length} código(s) QR confirmado(s) apuntando a dominio(s) .gob.mx.`,
    });
  }

  return { anomalias, scoreDelta, allGob, dominiosDistintos: dominiosDistintos.size };
}

// Cruza el RFC extraído del texto del PDF contra el RFC embebido en la URL del QR (si lo trae).
function cruzarRFCConQR(rfcTexto, qrs) {
  if (!rfcTexto || qrs.length === 0) return null;
  for (const q of qrs) {
    const m = q.contenido.match(/\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/);
    if (m && m[0] !== rfcTexto) {
      return {
        tipo: 'rfc_inconsistente_con_qr',
        severidad: 'alta',
        detalle: `El RFC en el texto del documento (${rfcTexto}) no coincide con el RFC codificado en el QR (${m[0]}).`,
      };
    }
  }
  return null;
}

async function analizarQR(buffer, rfcTexto) {
  try {
    const { qrs, paginasEscaneadas, totalPaginas } = await escanearQR(buffer);
    const evaluacion = evaluarQR(qrs);
    const cruce = cruzarRFCConQR(rfcTexto, qrs);
    if (cruce) {
      evaluacion.anomalias.push(cruce);
      evaluacion.scoreDelta -= 25;
    }
    return {
      disponible: true,
      qrs_encontrados: qrs.length,
      paginas_escaneadas: paginasEscaneadas,
      total_paginas: totalPaginas,
      dominios_confirmados_gob: evaluacion.allGob,
      qrs: qrs.map(({ pagina, hostname, esGob }) => ({ pagina, hostname, esGob })),
      anomalias: evaluacion.anomalias,
      scoreDelta: evaluacion.scoreDelta,
    };
  } catch (e) {
    // Si el PDF no se puede renderizar (corrupto, cifrado, etc.) no tumbamos
    // el análisis completo — se reporta como no disponible.
    return {
      disponible: false,
      error: e.message,
      qrs_encontrados: 0,
      anomalias: [],
      scoreDelta: 0,
    };
  }
}

module.exports = { analizarQR };
