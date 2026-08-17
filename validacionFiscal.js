// Extrae RFC/CURP/idCIF/Cadena Original del texto REAL (ya reconstruido, no
// bytes crudos) y aplica validaciones que antes eran imposibles:
// - Dígito verificador real de RFC y CURP (librerías oficiales validate-rfc / validate-curp)
// - Cruce RFC <-> CURP (los primeros 10 caracteres deben coincidir en persona física)
// - Formato de la Cadena Original / Sello Digital (validación de FORMA, no de firma —
//   ver nota en el motor sobre por qué no se hace verificación criptográfica real)

const validateRfc = require('validate-rfc');
const validateCurp = require('validate-curp');

function extraerCamposFiscales(texto) {
  const rfcMatch = texto.match(/RFC:?\s*([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/i)
    || texto.match(/\b([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/);
  const curpMatch = texto.match(/CURP:?\s*([A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d)\b/i)
    || texto.match(/\b([A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d)\b/);
  const idcifMatch = texto.match(/idCIF:?\s*(\d{6,})/i);
  const cadenaMatch = texto.match(/Cadena\s+Original\s+Sello:?\s*(\|[^\n]{10,180})/i);
  const selloMatch = texto.match(/Sello\s+Digital:?\s*([A-Za-z0-9+/=\s]{40,600})/i);

  return {
    rfc: rfcMatch ? rfcMatch[1].toUpperCase() : null,
    curp: curpMatch ? curpMatch[1].toUpperCase() : null,
    idcif: idcifMatch ? idcifMatch[1] : null,
    cadenaOriginal: cadenaMatch ? cadenaMatch[1].trim() : null,
    selloDigital: selloMatch ? selloMatch[1].replace(/\s+/g, '') : null,
  };
}

function validarCamposFiscales(campos) {
  const anomalias = [];
  const detalle = { rfc_valido: null, curp_valido: null, rfc_curp_coinciden: null, cadena_original_formato_ok: null };

  if (campos.rfc) {
    const r = validateRfc(campos.rfc);
    detalle.rfc_valido = r.isValid;
    if (!r.isValid) {
      anomalias.push({
        tipo: 'rfc_digito_verificador_invalido',
        severidad: 'alta',
        detalle: `El RFC "${campos.rfc}" no pasa la validación del dígito verificador oficial (${(r.errors || []).join(', ')}).`,
      });
    }
  }

  if (campos.curp) {
    const c = validateCurp(campos.curp);
    detalle.curp_valido = c.isValid;
    if (!c.isValid) {
      anomalias.push({
        tipo: 'curp_digito_verificador_invalido',
        severidad: 'alta',
        detalle: `La CURP "${campos.curp}" no pasa la validación del dígito verificador oficial.`,
      });
    }
  }

  if (campos.rfc && campos.curp) {
    const coinciden = campos.rfc.slice(0, 10) === campos.curp.slice(0, 10);
    detalle.rfc_curp_coinciden = coinciden;
    if (!coinciden) {
      anomalias.push({
        tipo: 'rfc_curp_inconsistentes',
        severidad: 'alta',
        detalle: `Los primeros 10 caracteres del RFC (${campos.rfc.slice(0, 10)}) no coinciden con los de la CURP (${campos.curp.slice(0, 10)}) — en persona física deberían ser iguales, se derivan del mismo nombre y fecha de nacimiento.`,
      });
    }
  }

  if (campos.cadenaOriginal) {
    // Formato esperado: |AAAA/MM/DD HH:MM:SS|RFC|TIPO DE DOCUMENTO
    const formatoOk = /^\|\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\|[A-ZÑ&0-9]{10,13}\|.+/i.test(campos.cadenaOriginal);
    detalle.cadena_original_formato_ok = formatoOk;
    if (!formatoOk) {
      anomalias.push({
        tipo: 'cadena_original_formato_invalido',
        severidad: 'media',
        detalle: 'La Cadena Original no sigue el formato esperado (|fecha|RFC|tipo de documento). Nota: esto valida forma, no la firma criptográfica.',
      });
    } else if (campos.rfc && !campos.cadenaOriginal.includes(campos.rfc)) {
      anomalias.push({
        tipo: 'cadena_original_rfc_no_coincide',
        severidad: 'alta',
        detalle: 'El RFC dentro de la Cadena Original no coincide con el RFC impreso en el documento.',
      });
    }
  }

  return { anomalias, detalle };
}

module.exports = { extraerCamposFiscales, validarCamposFiscales };
