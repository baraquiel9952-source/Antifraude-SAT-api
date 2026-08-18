// [MEJORA 15] Genera un reporte en PDF a partir de un resultado de analizarPDF(),
// para que el gestor se lo entregue al cliente como respaldo del análisis.
const PDFDocument = require('pdfkit');

const COLOR_VEREDICTO = {
  legitimo: '#2f6844',
  sospechoso: '#c98a2c',
  fraudulento: '#b23a2e',
};

function generarReportePDF(resultado, nombreDocumento, res) {
  const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
  doc.pipe(res);

  const color = COLOR_VEREDICTO[resultado.veredicto] || '#333333';

  doc.fontSize(18).fillColor('#111111').text('Reporte de Verificación Forense', { align: 'left' });
  doc.fontSize(10).fillColor('#666666').text(`Antifraude SAT · motor ${resultado.engine_version}`);
  doc.moveDown(1);

  doc.fontSize(9).fillColor('#666666').text(`Documento: ${nombreDocumento || 'no especificado'}`);
  doc.text(`Fecha del reporte: ${new Date().toLocaleString('es-MX')}`);
  doc.text(`Tipo de documento evaluado: ${resultado.tipo_documento}`);
  doc.moveDown(1);

  doc.rect(50, doc.y, 512, 60).fillAndStroke('#f5f5f0', color);
  const yBox = doc.y + 12;
  doc.fillColor(color).fontSize(20).text(resultado.veredicto.toUpperCase(), 65, yBox);
  doc.fillColor('#333333').fontSize(11).text(`Score: ${resultado.score}/100    Confianza del análisis: ${resultado.confianza}`, 65, yBox + 26);
  doc.moveDown(4);

  doc.fillColor('#111111').fontSize(13).text('Hallazgos', { underline: true });
  doc.moveDown(0.5);

  if (!resultado.anomalias || resultado.anomalias.length === 0) {
    doc.fontSize(10).fillColor('#444444').text('Sin anomalías detectadas en el análisis estructural.');
  } else {
    resultado.anomalias.forEach(a => {
      doc.fontSize(9).fillColor(a.severidad === 'alta' ? '#b23a2e' : '#c98a2c')
        .text(`[${a.severidad.toUpperCase()}] `, { continued: true })
        .fillColor('#333333').text(a.detalle);
      doc.moveDown(0.3);
    });
  }

  doc.moveDown(1);
  doc.fontSize(8).fillColor('#999999').text(
    'Este reporte es una señal técnica de apoyo basada en el análisis estructural del archivo PDF. ' +
    'No sustituye la verificación oficial ante el SAT u otra autoridad correspondiente.',
    { width: 512 }
  );

  doc.end();
}

module.exports = { generarReportePDF };
