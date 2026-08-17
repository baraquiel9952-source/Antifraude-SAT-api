// Extrae el texto REAL del PDF (reconstruido en orden de lectura por pdf.js),
// en vez de buscar con regex sobre los bytes crudos del stream — que es lo que
// causaba que el RFC/CURP no se detectaran en documentos reales del SAT.

const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

async function extraerTextoCompleto(buffer) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  let texto = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    texto += content.items.map(it => it.str).join(' ') + '\n';
  }
  return texto;
}

module.exports = { extraerTextoCompleto };
