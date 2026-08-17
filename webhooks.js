// Notifica por webhook cuando un análisis sale "fraudulento" — para no
// depender de estar viendo el panel. Fire-and-forget: si el webhook del
// cliente falla, no afecta la respuesta del análisis.

async function notificarSiFraudulento(webhookUrl, resultado, apiKeyInfo) {
  if (!webhookUrl || resultado.veredicto !== 'fraudulento') return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evento: 'documento_fraudulento_detectado',
        cliente: apiKeyInfo?.nombre || null,
        score: resultado.score,
        veredicto: resultado.veredicto,
        anomalias: resultado.anomalias,
        hash_documento: resultado.detalles_tecnicos.hash_documento,
        fecha: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    // no bloquear ni fallar el análisis si el webhook del cliente no responde
  }
}

module.exports = { notificarSiFraudulento };
